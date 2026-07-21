import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addPlanTasks,
  closePlan,
  createPlan,
  readActivePlan,
  renderPlan,
  replacePlan,
  updatePlanTask,
  type SharedPlan,
} from "../src/plans";
import { withFileLock } from "../src/paths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-ensemble-plans-"));
  tempDirs.push(root);
  return root;
}

async function completeAll(root: string, plan: SharedPlan): Promise<SharedPlan> {
  let current = plan;
  for (const task of plan.tasks) {
    current = await updatePlanTask(root, current.id, current.revision, task.id, "completed", "verified");
  }
  return current;
}

describe("shared Markdown plan", () => {
  it("creates a version 2 plan with stable task IDs and Markdown without Approved", async () => {
    const root = await project();
    const plan = await createPlan(root, "Feature", ["Implement behavior", "Run tests"]);
    expect(plan.version).toBe(2);
    expect(plan.revision).toBe(1);
    expect(plan.status).toBe("active");
    expect(plan.tasks.map((task) => task.id)).toEqual(["T001", "T002"]);

    const active = await readActivePlan(root);
    expect(active?.markdown).toContain("# Plan: Feature");
    expect(active?.markdown).toContain("- [ ] **T001** Implement behavior");
    expect(active?.markdown).toContain("Revision: **1**");
    expect(active?.markdown).not.toContain("Approved");
  });

  it("adds tasks using expectedPlanID and expectedRevision", async () => {
    const root = await project();
    const created = await createPlan(root, "Plan", ["Task"]);
    const added = await addPlanTasks(root, created.id, created.revision, ["New"]);
    expect(added.tasks.map((task) => task.id)).toEqual(["T001", "T002"]);
    expect(added.revision).toBe(created.revision + 1);
    await expect(addPlanTasks(root, created.id, created.revision, ["Stale"])).rejects.toThrow(/revision conflict/);
  });

  it("serializes concurrent updates so only one wins", async () => {
    const root = await project();
    const created = await createPlan(root, "Concurrent", ["First", "Second"]);
    const results = await Promise.allSettled([
      updatePlanTask(root, created.id, created.revision, "T001", "completed", "done"),
      updatePlanTask(root, created.id, created.revision, "T002", "completed", "done"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const active = await readActivePlan(root);
    expect(active?.plan.revision).toBe(created.revision + 1);
  });

  it("updates and closes without approve; close requires every task completed", async () => {
    const root = await project();
    const created = await createPlan(root, "Close", ["Task"]);
    await expect(closePlan(root, created.id, created.revision)).rejects.toThrow(/Every task/);
    const completed = await updatePlanTask(root, created.id, created.revision, "T001", "completed", "verified");
    const closed = await closePlan(root, completed.id, completed.revision);
    expect(closed.plan.status).toBe("closed");
    expect(closed.plan.revision).toBe(completed.revision + 1);
    expect(await readActivePlan(root)).toBeNull();
  });

  it("replace preserves id/createdAt, changes title/tasks, renumbers T001 and bumps revision", async () => {
    const root = await project();
    const created = await createPlan(root, "Original", ["A", "B"]);
    const replaced = await replacePlan(root, created.id, created.revision, "Rewritten", ["Only task"]);
    expect(replaced.id).toBe(created.id);
    expect(replaced.createdAt).toBe(created.createdAt);
    expect(replaced.title).toBe("Rewritten");
    expect(replaced.tasks).toHaveLength(1);
    const [onlyTask] = replaced.tasks;
    expect(onlyTask?.id).toBe("T001");
    expect(onlyTask?.text).toBe("Only task");
    expect(onlyTask?.status).toBe("pending");
    expect(replaced.revision).toBe(created.revision + 1);
    const active = await readActivePlan(root);
    expect(active?.plan).toEqual(replaced);
  });

  it("replace rejects an obsolete plan id or revision", async () => {
    const root = await project();
    const created = await createPlan(root, "Plan", ["Task"]);
    const moved = await updatePlanTask(root, created.id, created.revision, "T001", "pending");
    expect(moved.revision).toBe(created.revision + 1);
    await expect(replacePlan(root, created.id, created.revision, "Stale", ["Task"]))
      .rejects.toThrow(/revision conflict/);
    const otherID = "00000000-0000-1000-8000-000000000000";
    await expect(replacePlan(root, otherID, moved.revision, "Bad", ["Task"]))
      .rejects.toThrow(/plan id conflict/);
  });

  it("replace rejects once a task has been started", async () => {
    const root = await project();
    const created = await createPlan(root, "Started", ["Task"]);
    const started = await updatePlanTask(root, created.id, created.revision, "T001", "in_progress");
    await expect(replacePlan(root, started.id, started.revision, "After start", ["Task"]))
      .rejects.toThrow(/only be replaced/);
  });

  it("rejects an ABA operation that reuses the previous plan id after close and create", async () => {
    const root = await project();
    const a = await createPlan(root, "Plan A", ["Task"]);
    const completed = await completeAll(root, a);
    await closePlan(root, completed.id, completed.revision);
    const b = await createPlan(root, "Plan B", ["Task"]);
    // The stale id from plan A must be rejected even though B's current revision matches.
    await expect(updatePlanTask(root, a.id, b.revision, "T001", "completed", "x"))
      .rejects.toThrow(/plan id conflict/);
    await expect(replacePlan(root, a.id, b.revision, "Hijack", ["Task"]))
      .rejects.toThrow(/plan id conflict/);
  });

  it("does not follow a symlinked .code-ensemble directory", async () => {
    const root = await project();
    const outside = await project();
    try {
      await symlink(outside, join(root, ".code-ensemble"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(createPlan(root, "Unsafe", ["Task"])).rejects.toThrow(/safe directory/);
  });

  it("rejects creating a second active plan", async () => {
    const root = await project();
    await mkdir(join(root, ".code-ensemble"), { recursive: true });
    await createPlan(root, "First", ["Task"]);
    await expect(createPlan(root, "Second", ["Task"])).rejects.toThrow(/already exists/);
  });

  it("rejects manipulated task identifiers", async () => {
    const root = await project();
    await createPlan(root, "Tampered", ["Task"]);
    const file = join(root, ".code-ensemble", "TASKS.md");
    const markdown = await readFile(file, "utf8");
    await writeFile(file, markdown.replace('"id":"T001"', '"id":"T099"'), "utf8");
    await expect(readActivePlan(root)).rejects.toThrow(/invalid task/);
  });

  it("keeps the active plan unchanged when its archive already exists", async () => {
    const root = await project();
    const created = await createPlan(root, "Collision", ["Task"]);
    const completed = await updatePlanTask(root, created.id, created.revision, "T001", "completed", "verified");
    const archiveDirectory = join(root, ".code-ensemble", "plans");
    await mkdir(archiveDirectory);
    await writeFile(join(archiveDirectory, `${created.id}.md`), "existing archive", "utf8");

    await expect(closePlan(root, completed.id, completed.revision)).rejects.toThrow(/different archive/);
    const active = await readActivePlan(root);
    expect(active?.plan).toMatchObject({ status: "active", id: created.id, revision: completed.revision });
  });

  it("finishes a close interrupted after writing its archive", async () => {
    const root = await project();
    const created = await createPlan(root, "Interrupted close", ["Task"]);
    const completed = await updatePlanTask(root, created.id, created.revision, "T001", "completed", "verified");
    const archivedPlan: SharedPlan = {
      ...completed,
      status: "closed",
      revision: completed.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const archiveDirectory = join(root, ".code-ensemble", "plans");
    await mkdir(archiveDirectory);
    await writeFile(join(archiveDirectory, `${created.id}.md`), renderPlan(archivedPlan), "utf8");

    const closed = await closePlan(root, completed.id, completed.revision);
    expect(closed.plan).toEqual(archivedPlan);
    expect(await readActivePlan(root)).toBeNull();
  });

  it("cancels a mutation while it waits for the plan lock", async () => {
    const root = await project();
    const created = await createPlan(root, "Cancellation", ["Task"]);
    const file = join(root, ".code-ensemble", "TASKS.md");
    let release!: () => void;
    let acquired!: () => void;
    const acquiredLock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(file, async () => {
      acquired();
      await gate;
    });
    await acquiredLock;

    const controller = new AbortController();
    const mutation = updatePlanTask(
      root,
      created.id,
      created.revision,
      "T001",
      "completed",
      undefined,
      controller.signal,
    );
    controller.abort(new Error("cancelled"));
    await expect(mutation).rejects.toThrow("cancelled");
    release();
    await holder;
    expect((await readActivePlan(root))?.plan).toMatchObject({ id: created.id, revision: 1 });
  });

  it("allows only one writer to reclaim a stale lock", async () => {
    const root = await project();
    const stateDirectory = join(root, ".code-ensemble");
    await mkdir(stateDirectory);
    const lock = join(stateDirectory, "TASKS.md.lock");
    await mkdir(lock);
    const stale = new Date(Date.now() - 10_000);
    await utimes(lock, stale, stale);

    const results = await Promise.allSettled([
      createPlan(root, "First", ["Task"]),
      createPlan(root, "Second", ["Task"]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});