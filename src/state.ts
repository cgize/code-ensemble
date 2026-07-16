import { copyFile, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";

import { safeProjectFile, verifySafeParent, withFileLock } from "./paths.js";
import { claimMigrationOwner, hasMigrationOwner } from "./migration.js";
import { sessionScope } from "./scope.js";
import type { CodeEnsembleState, Phase } from "./types.js";

type StateDefaults = {
  autoLoop?: boolean;
  autoLoopMaxIterations?: number;
  reviewToPlanOnlyWithFindings?: boolean;
};
type TransitionMetadata = {
  summary?: string;
  planSummary?: string;
  reviewFindings?: string[];
  openIssues?: string[];
};

const MAX_HISTORY = 100;
const MAX_LIST_ITEMS = 100;
const MAX_TEXT_LENGTH = 16_000;
const MAX_LIST_ITEM_LENGTH = 4_000;
const MAX_LOOP_ITERATIONS = 1_000;
const MAX_STATE_BYTES = 1_024 * 1_024;
const stateLocks = new Map<string, Promise<void>>();
const PHASES = new Set<Phase>(["plan", "implement", "review"]);

const validTransitions: Record<Phase, Phase[]> = {
  plan: ["plan", "implement"],
  implement: ["implement", "review"],
  review: ["implement", "plan"],
};

export function createDefaultState(options: StateDefaults = {}): CodeEnsembleState {
  const autoLoopMaxIterations =
    typeof options.autoLoopMaxIterations === "number" &&
    Number.isFinite(options.autoLoopMaxIterations) &&
    options.autoLoopMaxIterations >= 1 &&
    options.autoLoopMaxIterations <= MAX_LOOP_ITERATIONS
      ? Math.floor(options.autoLoopMaxIterations)
      : 5;
  return {
    phase: "plan",
    proposedNextPhase: null,
    confirmationPending: false,
    history: [],
    lastPlanSummary: "",
    lastReviewFindings: [],
    openIssues: [],
    autoLoop: options.autoLoop ?? false,
    autoLoopMaxIterations,
    loopIteration: 0,
    pendingPlanSummary: "",
    pendingReviewFindings: [],
    pendingOpenIssues: [],
  };
}

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && PHASES.has(value as Phase);
}

function normalizePersistedState(value: unknown, defaults: StateDefaults): CodeEnsembleState {
  const defaultState = createDefaultState(defaults);
  if (value == null || typeof value !== "object") return defaultState;

  const state = value as Partial<CodeEnsembleState>;
  const autoLoopMaxIterations =
    typeof state.autoLoopMaxIterations === "number" &&
    Number.isFinite(state.autoLoopMaxIterations) &&
    state.autoLoopMaxIterations >= 1 &&
    state.autoLoopMaxIterations <= MAX_LOOP_ITERATIONS
      ? Math.floor(state.autoLoopMaxIterations)
      : defaultState.autoLoopMaxIterations;

  const phase: Phase = isPhase(state.phase) ? state.phase : defaultState.phase;
  const proposedNextPhase: Phase | null =
    isPhase(state.proposedNextPhase) && validTransitions[phase]?.includes(state.proposedNextPhase)
      ? state.proposedNextPhase
      : null;

  const strings = (candidate: unknown, fallback: string[]): string[] =>
    Array.isArray(candidate)
      ? candidate
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.slice(0, MAX_LIST_ITEM_LENGTH))
          .slice(-MAX_LIST_ITEMS)
      : fallback;
  const text = (candidate: unknown, fallback: string): string =>
    typeof candidate === "string" ? candidate.slice(0, MAX_TEXT_LENGTH) : fallback;

  return {
    phase,
    proposedNextPhase,
    confirmationPending: proposedNextPhase !== null
      ? typeof state.confirmationPending === "boolean"
        ? state.confirmationPending
        : defaultState.confirmationPending
      : false,
     history: Array.isArray(state.history)
       ? state.history
           .filter(
             (entry): entry is CodeEnsembleState["history"][number] =>
               !!entry &&
               typeof entry === "object" &&
               isPhase((entry as { from?: unknown }).from) &&
               isPhase((entry as { to?: unknown }).to) &&
               typeof (entry as { at?: unknown }).at === "string" &&
               typeof (entry as { summary?: unknown }).summary === "string",
           )
           .map((entry) => ({
             from: entry.from,
             to: entry.to,
             at: entry.at.slice(0, 100),
             summary: entry.summary.slice(0, MAX_LIST_ITEM_LENGTH),
           }))
           .slice(-MAX_HISTORY)
       : defaultState.history,
     lastPlanSummary: text(state.lastPlanSummary, defaultState.lastPlanSummary),
     lastReviewFindings: strings(state.lastReviewFindings, defaultState.lastReviewFindings),
     openIssues: strings(state.openIssues, defaultState.openIssues),
    autoLoop: typeof state.autoLoop === "boolean" ? state.autoLoop : defaultState.autoLoop,
    autoLoopMaxIterations,
    loopIteration:
        typeof state.loopIteration === "number" && Number.isFinite(state.loopIteration) && state.loopIteration >= 0 && state.loopIteration <= MAX_LOOP_ITERATIONS
        ? Math.floor(state.loopIteration)
        : defaultState.loopIteration,
     pendingPlanSummary: text(state.pendingPlanSummary, defaultState.pendingPlanSummary),
     pendingReviewFindings: strings(state.pendingReviewFindings, defaultState.pendingReviewFindings),
     pendingOpenIssues: strings(state.pendingOpenIssues, defaultState.pendingOpenIssues),
   };
}

async function getStatePath(worktree: string, stateFile: string, sessionID?: string): Promise<{ root: string; path: string }> {
  const legacy = await safeProjectFile(worktree, stateFile, { createParent: true });
  if (!sessionID) return legacy;
  return safeProjectFile(
    legacy.root,
    `${dirname(legacy.path)}/${basenameWithoutExtension(legacy.path)}-sessions/${sessionScope(sessionID)}.json`,
    { createParent: true },
  );
}

function basenameWithoutExtension(path: string): string {
  const name = basename(path);
  return name.endsWith(".json") ? name.slice(0, -5) : name;
}

async function withStateLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = stateLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const queued = previous.then(() => current);
  stateLocks.set(key, queued);
  await previous;
  try {
    return await withFileLock(key, operation);
  } finally {
    release();
    if (stateLocks.get(key) === queued) stateLocks.delete(key);
  }
}

async function writeStateFile(
  root: string,
  fullPath: string,
  state: CodeEnsembleState,
  defaults: StateDefaults,
): Promise<CodeEnsembleState> {
  const safeState = normalizePersistedState(state, defaults);
  const serialized = JSON.stringify(safeState, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new Error(`State file exceeds ${MAX_STATE_BYTES} bytes`);
  }
  await verifySafeParent(root, fullPath);
  const temporaryPath = `${fullPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
    await verifySafeParent(root, temporaryPath);
    await rename(temporaryPath, fullPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  return safeState;
}

async function readStateUnlocked(
  worktree: string,
  stateFile: string,
  root: string,
  fullPath: string,
  defaults: StateDefaults,
  sessionID?: string,
): Promise<CodeEnsembleState> {
  if (!sessionID && (await hasMigratedState(fullPath) || await hasMigrationOwner(worktree))) {
    throw new Error("A sessionID is required after code-ensemble state has been migrated to session scope");
  }

  try {
    const content = await readBoundedStateFile(fullPath);
    return normalizePersistedState(JSON.parse(content), defaults);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && sessionID) {
      const legacy = await getStatePath(worktree, stateFile);
      const ownsLegacyMigration = await claimMigrationOwner(worktree, sessionID);
      if (!ownsLegacyMigration) {
        const result = await writeStateFile(root, fullPath, createDefaultState(defaults), defaults);
        await writeMigrationMarker(legacy.path);
        return result;
      }
      return withStateLock(legacy.path, async () => {
        try {
          const existing = await readBoundedStateFile(fullPath);
          return normalizePersistedState(JSON.parse(existing), defaults);
        } catch (existingError) {
          if ((existingError as NodeJS.ErrnoException).code !== "ENOENT") throw existingError;
        }

        const migratingPath = `${legacy.path}.migrating`;
        try {
          try {
            await rename(legacy.path, migratingPath);
          } catch (claimError) {
            if ((claimError as NodeJS.ErrnoException).code !== "ENOENT") throw claimError;
          }

          let legacyContent: string;
          try {
            legacyContent = await readBoundedStateFile(migratingPath);
          } catch (migrationError) {
            if ((migrationError as NodeJS.ErrnoException).code !== "ENOENT") throw migrationError;
            const result = await writeStateFile(root, fullPath, createDefaultState(defaults), defaults);
            await writeMigrationMarker(legacy.path);
            return result;
          }

          let migrated: CodeEnsembleState;
          try {
            migrated = normalizePersistedState(JSON.parse(legacyContent), defaults);
          } catch {
            await copyFile(migratingPath, `${legacy.path}.bak.${Date.now()}.${randomUUID()}`);
            await rename(migratingPath, `${legacy.path}.invalid.${Date.now()}.${randomUUID()}`);
            migrated = createDefaultState(defaults);
          }
          const result = await writeStateFile(root, fullPath, migrated, defaults);
          await rename(migratingPath, `${legacy.path}.migrated.${Date.now()}.${randomUUID()}`).catch((renameError) => {
            if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") throw renameError;
          });
          if (!await hasMigratedState(legacy.path)) await writeMigrationMarker(legacy.path);
          return result;
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") throw legacyError;
          const result = await writeStateFile(root, fullPath, createDefaultState(defaults), defaults);
          await writeMigrationMarker(legacy.path);
          return result;
        }
      });
    }

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return writeStateFile(root, fullPath, createDefaultState(defaults), defaults);
    }

    if (error instanceof SyntaxError) {
      await copyFile(fullPath, `${fullPath}.bak.${Date.now()}.${randomUUID()}`);
      await rename(fullPath, `${fullPath}.invalid.${Date.now()}.${randomUUID()}`);
      return writeStateFile(root, fullPath, createDefaultState(defaults), defaults);
    }
    throw error;
  }
}

async function readBoundedStateFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`State path is not a regular file: ${path}`);
    if (info.size > MAX_STATE_BYTES) throw new Error(`State file exceeds ${MAX_STATE_BYTES} bytes`);
    return handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function hasMigratedState(legacyPath: string): Promise<boolean> {
  try {
    const prefix = `${basename(legacyPath)}.migrated.`;
    return (await readdir(dirname(legacyPath))).some((entry) => entry.startsWith(prefix));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeMigrationMarker(legacyPath: string): Promise<void> {
  if (await hasMigratedState(legacyPath)) return;
  const marker = `${legacyPath}.migrated.${Date.now()}.${randomUUID()}`;
  await writeFile(marker, "State storage migrated to per-session files.\n", { encoding: "utf8", flag: "wx" });
}

export async function readCodeEnsembleState(
  worktree: string,
  stateFile: string,
  defaults: StateDefaults = {},
  sessionID?: string,
): Promise<CodeEnsembleState> {
  const resolved = await getStatePath(worktree, stateFile, sessionID);
  return withStateLock(resolved.path, () =>
    readStateUnlocked(worktree, stateFile, resolved.root, resolved.path, defaults, sessionID),
  );
}

async function mutateState(
  worktree: string,
  stateFile: string,
  defaults: StateDefaults,
  operation: (state: CodeEnsembleState, root: string, fullPath: string) => Promise<CodeEnsembleState>,
  sessionID?: string,
): Promise<CodeEnsembleState> {
  const resolved = await getStatePath(worktree, stateFile, sessionID);
  return withStateLock(resolved.path, async () => {
    const state = await readStateUnlocked(worktree, stateFile, resolved.root, resolved.path, defaults, sessionID);
    return operation(state, resolved.root, resolved.path);
  });
}

export async function proposeCodeEnsembleTransition(
  worktree: string,
  stateFile: string,
  nextPhase: Phase,
  metadata: TransitionMetadata = {},
  defaults: StateDefaults = {},
  sessionID?: string,
): Promise<CodeEnsembleState> {
  return mutateState(worktree, stateFile, defaults, async (state, root, fullPath) => {
    const enforceFindingsCheck = defaults.reviewToPlanOnlyWithFindings ?? true;

  if (!validTransitions[state.phase].includes(nextPhase)) {
    throw new Error(`Invalid transition from ${state.phase} to ${nextPhase}`);
  }

  if (nextPhase === state.phase) {
    return writeStateFile(root, fullPath, {
      ...state,
      proposedNextPhase: null,
      confirmationPending: false,
      pendingPlanSummary: "",
      pendingReviewFindings: [],
      pendingOpenIssues: [],
    }, defaults);
  }

  if (state.autoLoop) {
    if (
      state.phase === "review" &&
      nextPhase === "implement" &&
      state.loopIteration >= state.autoLoopMaxIterations
    ) {
      throw new Error(
        `Auto-loop iteration cap reached (${state.autoLoopMaxIterations}). ` +
          `Disable auto-loop or edit code-ensemble.json to raise transitions.autoLoopMaxIterations, then reset the session.`,
      );
    }
    return applyTransition(
      root,
      fullPath,
      state,
      nextPhase,
      {
        planSummary: metadata.planSummary,
        reviewFindings: metadata.reviewFindings,
        openIssues: metadata.openIssues,
        summary: autoLoopSummary(state.phase, nextPhase),
      },
      enforceFindingsCheck,
      defaults,
    );
  }

  if (
    enforceFindingsCheck &&
    state.phase === "review" &&
    nextPhase === "plan" &&
    (metadata.reviewFindings?.length ?? 0) === 0
  ) {
    throw new Error("review -> plan requires review findings");
  }

  return writeStateFile(root, fullPath, {
    ...state,
    proposedNextPhase: nextPhase,
    confirmationPending: true,
    pendingPlanSummary: metadata.planSummary ?? "",
    pendingReviewFindings: metadata.reviewFindings ?? [],
    pendingOpenIssues: metadata.openIssues ?? [],
  }, defaults);
  }, sessionID);
}

function autoLoopSummary(from: Phase, to: Phase): string {
  if (from === "plan" && to === "implement") return "Auto-loop: plan -> implement";
  if (from === "implement" && to === "review") return "Auto-loop: implement -> review";
  if (from === "review" && to === "implement") return "Auto-loop: review -> implement (fix cycle)";
  if (from === "review" && to === "plan") return "Auto-loop: review -> plan";
  return `Auto-loop: ${from} -> ${to}`;
}

async function applyTransition(
  root: string,
  fullPath: string,
  state: CodeEnsembleState,
  nextPhase: Phase,
  metadata: TransitionMetadata = {},
  enforceFindingsCheck = true,
  defaults: StateDefaults = {},
): Promise<CodeEnsembleState> {
  if (
    enforceFindingsCheck &&
    state.phase === "review" &&
    nextPhase === "plan" &&
    (metadata.reviewFindings?.length ?? 0) === 0
  ) {
    throw new Error("review -> plan requires review findings");
  }

  const isFixCycle = state.phase === "review" && nextPhase === "implement";
  const isFreshImplementation = state.phase === "plan" && nextPhase === "implement";

  const summary =
    metadata.summary ??
    (state.phase === "plan"
      ? metadata.planSummary ?? state.lastPlanSummary ?? "Plan approved"
      : state.phase === "review"
        ? metadata.reviewFindings != null && metadata.reviewFindings.length > 0
          ? metadata.reviewFindings.join("; ")
          : nextPhase === "implement"
            ? "Review requested implementation follow-up"
            : "Review approved"
        : `Implementation moved to ${nextPhase}`);

  const nextState: CodeEnsembleState = {
    ...state,
    phase: nextPhase,
    proposedNextPhase: null,
    confirmationPending: false,
    lastPlanSummary: metadata.planSummary ?? state.lastPlanSummary,
    lastReviewFindings: state.phase === "review" ? metadata.reviewFindings ?? [] : state.lastReviewFindings,
    openIssues: metadata.openIssues ?? state.openIssues,
    pendingPlanSummary: "",
    pendingReviewFindings: [],
    pendingOpenIssues: [],
    loopIteration: isFreshImplementation
      ? 0
      : isFixCycle
        ? state.loopIteration + 1
        : state.loopIteration,
    history: [
      ...state.history,
      {
        from: state.phase,
        to: nextPhase,
        at: new Date().toISOString(),
        summary,
      },
    ],
  };

  return writeStateFile(root, fullPath, nextState, defaults);
}

export async function approveCodeEnsembleTransition(
  worktree: string,
  stateFile: string,
  metadata: TransitionMetadata = {},
  defaults: StateDefaults = {},
  sessionID?: string,
): Promise<CodeEnsembleState> {
  return mutateState(worktree, stateFile, defaults, async (state, root, fullPath) => {

  if (!state.confirmationPending || !state.proposedNextPhase) {
    throw new Error("No pending transition to approve");
  }

  const enforceFindingsCheck = defaults.reviewToPlanOnlyWithFindings ?? true;
  const pendingReviewFindings =
    state.pendingReviewFindings.length > 0 ? state.pendingReviewFindings : undefined;
  const effectiveReviewFindings = metadata.reviewFindings ?? pendingReviewFindings;
  const reviewFindingsForCheck = effectiveReviewFindings ?? [];

  const hasFindings = reviewFindingsForCheck.length > 0;

  if (
    enforceFindingsCheck &&
    state.phase === "review" &&
    state.proposedNextPhase === "plan" &&
    !hasFindings
  ) {
    throw new Error("review -> plan requires review findings");
  }

  return applyTransition(
    root,
    fullPath,
    state,
    state.proposedNextPhase,
    {
      planSummary: metadata.planSummary ?? (state.pendingPlanSummary || undefined),
      reviewFindings: effectiveReviewFindings,
      openIssues:
        metadata.openIssues ?? (state.pendingOpenIssues.length > 0 ? state.pendingOpenIssues : undefined),
    },
    enforceFindingsCheck,
    defaults,
  );
  }, sessionID);
}

export async function forceCodeEnsemblePhase(
  worktree: string,
  stateFile: string,
  phase: Phase,
  summary: string,
  defaults: StateDefaults = {},
  sessionID?: string,
): Promise<CodeEnsembleState> {
  return mutateState(worktree, stateFile, defaults, async (state, root, fullPath) => {

  if (!isPhase(phase)) {
    throw new Error(`Invalid forced phase: ${phase}`);
  }

  return writeStateFile(root, fullPath, {
    ...state,
    phase,
    proposedNextPhase: null,
    confirmationPending: false,
    lastPlanSummary: phase === "plan" ? "" : state.lastPlanSummary,
    lastReviewFindings: phase === "plan" ? [] : state.lastReviewFindings,
    pendingPlanSummary: "",
    pendingReviewFindings: [],
    pendingOpenIssues: [],
    loopIteration: phase === "plan" ? 0 : state.loopIteration,
    history: [
      ...state.history,
      {
        from: state.phase,
        to: phase,
        at: new Date().toISOString(),
        summary,
      },
    ],
  }, defaults);
  }, sessionID);
}

export async function resetCodeEnsembleState(
  worktree: string,
  stateFile: string,
  defaults: StateDefaults = {},
  sessionID?: string,
): Promise<CodeEnsembleState> {
  await readCodeEnsembleState(worktree, stateFile, defaults, sessionID);
  const resolved = await getStatePath(worktree, stateFile, sessionID);

  return withStateLock(resolved.path, async () => {
    try {
      await copyFile(resolved.path, `${resolved.path}.bak.${Date.now()}.${randomUUID()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return writeStateFile(resolved.root, resolved.path, createDefaultState(defaults), defaults);
  });
}

export async function setCodeEnsembleAutoLoop(
  worktree: string,
  stateFile: string,
  options: { enabled: boolean },
  defaults: StateDefaults = {},
  sessionID?: string,
): Promise<CodeEnsembleState> {
  return mutateState(worktree, stateFile, defaults, async (state, root, fullPath) => {

  if (options.enabled && state.confirmationPending && state.proposedNextPhase) {
    if (
      state.phase === "review" &&
      state.proposedNextPhase === "implement" &&
      state.loopIteration >= state.autoLoopMaxIterations
    ) {
      throw new Error(
        `Auto-loop iteration cap reached (${state.autoLoopMaxIterations}). ` +
          `Disable auto-loop or edit code-ensemble.json to raise transitions.autoLoopMaxIterations, then reset the session.`,
      );
    }

    return applyTransition(
      root,
      fullPath,
      {
        ...state,
        autoLoop: true,
      },
      state.proposedNextPhase,
      {
        planSummary: state.pendingPlanSummary || undefined,
        reviewFindings: state.pendingReviewFindings.length > 0 ? state.pendingReviewFindings : undefined,
        openIssues: state.pendingOpenIssues.length > 0 ? state.pendingOpenIssues : undefined,
        summary: autoLoopSummary(state.phase, state.proposedNextPhase),
      },
      defaults.reviewToPlanOnlyWithFindings ?? true,
      defaults,
    );
  }

  return writeStateFile(root, fullPath, {
    ...state,
    autoLoop: options.enabled,
    loopIteration: options.enabled ? state.loopIteration : 0,
  }, defaults);
  }, sessionID);
}
