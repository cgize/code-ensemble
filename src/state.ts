import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

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

const validTransitions: Record<Phase, Phase[]> = {
  plan: ["plan", "implement"],
  implement: ["implement", "review"],
  review: ["implement", "plan"],
};

export function createDefaultState(options: StateDefaults = {}): CodeEnsembleState {
  const autoLoopMaxIterations =
    typeof options.autoLoopMaxIterations === "number" &&
    Number.isFinite(options.autoLoopMaxIterations) &&
    options.autoLoopMaxIterations >= 1
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
  return typeof value === "string" && value in validTransitions;
}

function normalizePersistedState(value: unknown, defaults: StateDefaults): CodeEnsembleState {
  const defaultState = createDefaultState(defaults);
  if (value == null || typeof value !== "object") return defaultState;

  const state = value as Partial<CodeEnsembleState>;
  const autoLoopMaxIterations =
    typeof state.autoLoopMaxIterations === "number" &&
    Number.isFinite(state.autoLoopMaxIterations) &&
    state.autoLoopMaxIterations >= 1
      ? Math.floor(state.autoLoopMaxIterations)
      : defaultState.autoLoopMaxIterations;

  const phase: Phase = isPhase(state.phase) ? state.phase : defaultState.phase;
  const proposedNextPhase: Phase | null =
    isPhase(state.proposedNextPhase) && validTransitions[phase]?.includes(state.proposedNextPhase)
      ? state.proposedNextPhase
      : null;

  return {
    phase,
    proposedNextPhase,
    confirmationPending: proposedNextPhase !== null
      ? typeof state.confirmationPending === "boolean"
        ? state.confirmationPending
        : defaultState.confirmationPending
      : false,
    history: Array.isArray(state.history) ? state.history : defaultState.history,
    lastPlanSummary: typeof state.lastPlanSummary === "string" ? state.lastPlanSummary : defaultState.lastPlanSummary,
    lastReviewFindings: Array.isArray(state.lastReviewFindings)
      ? state.lastReviewFindings
      : defaultState.lastReviewFindings,
    openIssues: Array.isArray(state.openIssues) ? state.openIssues : defaultState.openIssues,
    autoLoop: typeof state.autoLoop === "boolean" ? state.autoLoop : defaultState.autoLoop,
    autoLoopMaxIterations,
    loopIteration:
      typeof state.loopIteration === "number" && Number.isFinite(state.loopIteration) && state.loopIteration >= 0
        ? Math.floor(state.loopIteration)
        : defaultState.loopIteration,
    pendingPlanSummary:
      typeof state.pendingPlanSummary === "string" ? state.pendingPlanSummary : defaultState.pendingPlanSummary,
    pendingReviewFindings: Array.isArray(state.pendingReviewFindings)
      ? state.pendingReviewFindings
      : defaultState.pendingReviewFindings,
    pendingOpenIssues: Array.isArray(state.pendingOpenIssues)
      ? state.pendingOpenIssues
      : defaultState.pendingOpenIssues,
  };
}

function getStatePath(worktree: string, stateFile: string): string {
  return resolve(worktree, stateFile);
}

async function writeStateFile(
  worktree: string,
  stateFile: string,
  state: CodeEnsembleState,
): Promise<CodeEnsembleState> {
  const fullPath = getStatePath(worktree, stateFile);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(state, null, 2));
  return state;
}

export async function readCodeEnsembleState(
  worktree: string,
  stateFile: string,
  defaults: StateDefaults = {},
): Promise<CodeEnsembleState> {
  const fullPath = getStatePath(worktree, stateFile);

  try {
    const content = await readFile(fullPath, "utf8");
    return normalizePersistedState(JSON.parse(content), defaults);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return writeStateFile(worktree, stateFile, createDefaultState(defaults));
    }

    try {
      await copyFile(fullPath, `${fullPath}.bak`);
      await rename(fullPath, `${fullPath}.invalid`);
    } catch {
      // ignore backup failures during recovery
    }

    return writeStateFile(worktree, stateFile, createDefaultState(defaults));
  }
}

export async function proposeCodeEnsembleTransition(
  worktree: string,
  stateFile: string,
  nextPhase: Phase,
  metadata: TransitionMetadata = {},
  defaults: StateDefaults = {},
): Promise<CodeEnsembleState> {
  const state = await readCodeEnsembleState(worktree, stateFile, defaults);
  const enforceFindingsCheck = defaults.reviewToPlanOnlyWithFindings ?? true;

  if (!validTransitions[state.phase].includes(nextPhase)) {
    throw new Error(`Invalid transition from ${state.phase} to ${nextPhase}`);
  }

  if (nextPhase === state.phase) {
    return writeStateFile(worktree, stateFile, {
      ...state,
      proposedNextPhase: null,
      confirmationPending: false,
      pendingPlanSummary: "",
      pendingReviewFindings: [],
      pendingOpenIssues: [],
    });
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
      worktree,
      stateFile,
      state,
      nextPhase,
      {
        planSummary: metadata.planSummary,
        reviewFindings: metadata.reviewFindings,
        openIssues: metadata.openIssues,
        summary: autoLoopSummary(state.phase, nextPhase),
      },
      enforceFindingsCheck,
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

  return writeStateFile(worktree, stateFile, {
    ...state,
    proposedNextPhase: nextPhase,
    confirmationPending: true,
    pendingPlanSummary: metadata.planSummary ?? "",
    pendingReviewFindings: metadata.reviewFindings ?? [],
    pendingOpenIssues: metadata.openIssues ?? [],
  });
}

function autoLoopSummary(from: Phase, to: Phase): string {
  if (from === "plan" && to === "implement") return "Auto-loop: plan -> implement";
  if (from === "implement" && to === "review") return "Auto-loop: implement -> review";
  if (from === "review" && to === "implement") return "Auto-loop: review -> implement (fix cycle)";
  if (from === "review" && to === "plan") return "Auto-loop: review -> plan";
  return `Auto-loop: ${from} -> ${to}`;
}

async function applyTransition(
  worktree: string,
  stateFile: string,
  state: CodeEnsembleState,
  nextPhase: Phase,
  metadata: TransitionMetadata = {},
  enforceFindingsCheck = true,
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

  return writeStateFile(worktree, stateFile, nextState);
}

export async function approveCodeEnsembleTransition(
  worktree: string,
  stateFile: string,
  metadata: TransitionMetadata = {},
  defaults: StateDefaults = {},
): Promise<CodeEnsembleState> {
  const state = await readCodeEnsembleState(worktree, stateFile, defaults);

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
    worktree,
    stateFile,
    state,
    state.proposedNextPhase,
    {
      planSummary: metadata.planSummary ?? (state.pendingPlanSummary || undefined),
      reviewFindings: effectiveReviewFindings,
      openIssues:
        metadata.openIssues ?? (state.pendingOpenIssues.length > 0 ? state.pendingOpenIssues : undefined),
    },
    enforceFindingsCheck,
  );
}

export async function forceCodeEnsemblePhase(
  worktree: string,
  stateFile: string,
  phase: Phase,
  summary: string,
  defaults: StateDefaults = {},
): Promise<CodeEnsembleState> {
  const state = await readCodeEnsembleState(worktree, stateFile, defaults);

  if (!validTransitions[state.phase]?.includes(phase)) {
    throw new Error(`Invalid forced transition from ${state.phase} to ${phase}`);
  }

  return writeStateFile(worktree, stateFile, {
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
  });
}

export async function resetCodeEnsembleState(
  worktree: string,
  stateFile: string,
  defaults: StateDefaults = {},
): Promise<CodeEnsembleState> {
  const fullPath = getStatePath(worktree, stateFile);

  try {
    await copyFile(fullPath, `${fullPath}.bak`);
  } catch {
    // no state yet
  }

  return writeStateFile(worktree, stateFile, createDefaultState(defaults));
}

export async function setCodeEnsembleAutoLoop(
  worktree: string,
  stateFile: string,
  options: { enabled: boolean },
  defaults: StateDefaults = {},
): Promise<CodeEnsembleState> {
  const state = await readCodeEnsembleState(worktree, stateFile, defaults);

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
      worktree,
      stateFile,
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
    );
  }

  return writeStateFile(worktree, stateFile, {
    ...state,
    autoLoop: options.enabled,
    loopIteration: options.enabled ? state.loopIteration : 0,
  });
}
