import { lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { safeProjectFile, verifySafeParent, withFileLock } from "./paths.js";
import { sessionScope } from "./scope.js";
import type { DelegationGroupSnapshot, DelegationSnapshot } from "./delegations.js";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 100;
const MAX_DESCRIPTION_LENGTH = 4_000;
const MAX_RESULT_LENGTH = 64 * 1024;
const ROLES = new Set(["planner", "architect"]);
const TASK_STATUSES = new Set(["running", "completed", "error", "cancelled"]);
const GROUP_STATUSES = new Set(["running", "completed", "error", "cancelled"]);
const NOTIFICATION_STATUSES = new Set(["none", "pending", "sending", "sent", "failed"]);

export type PersistedDelegationState = {
  version: 1;
  tasks: DelegationSnapshot[];
  groups: DelegationGroupSnapshot[];
};

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const encoded = Buffer.from(value, "utf8");
  return encoded.length <= maximum ? value : encoded.subarray(0, maximum).toString("utf8");
}

function normalizeTask(value: unknown, parentSessionID: string): DelegationSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const task = value as Partial<DelegationSnapshot>;
  if (typeof task.taskID !== "string" || !ROLES.has(task.role ?? "") || !TASK_STATUSES.has(task.status ?? "")) {
    return undefined;
  }
  return {
    taskID: task.taskID.slice(0, 200),
    parentSessionID,
    childSessionID: text(task.childSessionID, 200),
    groupID: text(task.groupID, 200),
    description: text(task.description, MAX_DESCRIPTION_LENGTH) ?? "Recovered delegation",
    role: task.role as DelegationSnapshot["role"],
    status: task.status as DelegationSnapshot["status"],
    notification: NOTIFICATION_STATUSES.has(task.notification ?? "")
      ? task.notification as DelegationSnapshot["notification"]
      : "failed",
    model: text(task.model, 500),
    usedFallback: typeof task.usedFallback === "boolean" ? task.usedFallback : undefined,
    output: task.status === "completed" ? text(task.output, MAX_RESULT_LENGTH) : undefined,
    error: task.status === "completed" ? undefined : text(task.error, MAX_RESULT_LENGTH),
    completedAt: typeof task.completedAt === "number" && Number.isFinite(task.completedAt)
      ? task.completedAt
      : undefined,
  };
}

function normalizeGroup(value: unknown, parentSessionID: string): DelegationGroupSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const group = value as Partial<DelegationGroupSnapshot>;
  if (
    typeof group.groupID !== "string" ||
    !GROUP_STATUSES.has(group.status ?? "") ||
    !Array.isArray(group.taskIDs)
  ) return undefined;
  const taskIDs = group.taskIDs
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.slice(0, 200))
    .slice(0, 20);
  if (taskIDs.length === 0) return undefined;
  return {
    groupID: group.groupID.slice(0, 200),
    parentSessionID,
    description: text(group.description, MAX_DESCRIPTION_LENGTH) ?? "Recovered delegation group",
    taskIDs,
    status: group.status as DelegationGroupSnapshot["status"],
    notification: NOTIFICATION_STATUSES.has(group.notification ?? "")
      ? group.notification as DelegationGroupSnapshot["notification"]
      : "failed",
    completedAt: typeof group.completedAt === "number" && Number.isFinite(group.completedAt)
      ? group.completedAt
      : undefined,
  };
}

function normalizeState(value: unknown, parentSessionID: string): PersistedDelegationState {
  if (!value || typeof value !== "object") return { version: 1, tasks: [], groups: [] };
  const state = value as { tasks?: unknown; groups?: unknown };
  return {
    version: 1,
    tasks: (Array.isArray(state.tasks) ? state.tasks : [])
      .map((task) => normalizeTask(task, parentSessionID))
      .filter((task): task is DelegationSnapshot => !!task)
      .slice(-MAX_RECORDS),
    groups: (Array.isArray(state.groups) ? state.groups : [])
      .map((group) => normalizeGroup(group, parentSessionID))
      .filter((group): group is DelegationGroupSnapshot => !!group)
      .slice(-MAX_RECORDS),
  };
}

function serializeBoundedState(value: PersistedDelegationState, parentSessionID: string): string {
  const state = normalizeState(value, parentSessionID);
  let serialized = JSON.stringify(state, null, 2);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_STATE_BYTES) return serialized;

  state.tasks = state.tasks.map((task) => ({
    ...task,
    description: text(task.description, 1_024) ?? "Delegation",
    output: text(task.output, 8 * 1024),
    error: text(task.error, 8 * 1024),
  }));
  state.groups = state.groups.map((group) => ({
    ...group,
    description: text(group.description, 1_024) ?? "Delegation group",
  }));
  serialized = JSON.stringify(state, null, 2);

  while (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES && (state.tasks.length > 0 || state.groups.length > 0)) {
    if (state.tasks.length >= state.groups.length) state.tasks.shift();
    else state.groups.shift();
    serialized = JSON.stringify(state, null, 2);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Delegation state exceeds its size limit");
  }
  return serialized;
}

export class DelegationPersistence {
  constructor(private readonly worktree: string) {}

  async load(parentSessionID: string): Promise<PersistedDelegationState> {
    const file = await this.file(parentSessionID);
    try {
      const before = await lstat(file.path);
      if (before.isSymbolicLink() || !before.isFile()) throw new Error("Delegation state is not a safe regular file");
      const handle = await open(file.path, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) {
          throw new Error("Delegation state changed while it was being opened");
        }
        if (info.size > MAX_STATE_BYTES) throw new Error("Delegation state exceeds its size limit");
        const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_STATE_BYTES + 1));
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > MAX_STATE_BYTES) throw new Error("Delegation state exceeds its size limit");
        return normalizeState(JSON.parse(buffer.subarray(0, offset).toString("utf8")), parentSessionID);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, tasks: [], groups: [] };
      throw error;
    }
  }

  async delete(parentSessionID: string): Promise<void> {
    const file = await this.file(parentSessionID);
    await withFileLock(file.path, async () => {
      await unlink(file.path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    });
  }

  async save(parentSessionID: string, state: PersistedDelegationState): Promise<void> {
    const file = await this.file(parentSessionID);
    await withFileLock(file.path, async () => {
      const serialized = serializeBoundedState(state, parentSessionID);
      await verifySafeParent(file.root, file.path);
      const temporaryPath = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
        await verifySafeParent(file.root, temporaryPath);
        await rename(temporaryPath, file.path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
  }

  private file(parentSessionID: string): Promise<{ root: string; path: string }> {
    return safeProjectFile(
      this.worktree,
      `.opencode/state/code-ensemble-delegations/${sessionScope(parentSessionID)}.json`,
      { createParent: true },
    );
  }
}
