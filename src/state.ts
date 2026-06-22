import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { CodeSwarmState, Phase } from "./types.js";

const validTransitions: Record<Phase, Phase[]> = {
  plan: ["plan", "implement"],
  implement: ["implement", "review"],
  review: ["implement", "plan"],
};

export function createDefaultState(): CodeSwarmState {
  return {
    phase: "plan",
    proposedNextPhase: null,
    confirmationPending: false,
    history: [],
    lastPlanSummary: "",
    lastReviewFindings: [],
    openIssues: [],
  };
}

function getStatePath(worktree: string, stateFile: string): string {
  return resolve(worktree, stateFile);
}

async function writeStateFile(
  worktree: string,
  stateFile: string,
  state: CodeSwarmState,
): Promise<CodeSwarmState> {
  const fullPath = getStatePath(worktree, stateFile);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, JSON.stringify(state, null, 2));
  return state;
}

export async function readCodeSwarmState(worktree: string, stateFile: string): Promise<CodeSwarmState> {
  const fullPath = getStatePath(worktree, stateFile);

  try {
    const content = await readFile(fullPath, "utf8");
    return JSON.parse(content) as CodeSwarmState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return writeStateFile(worktree, stateFile, createDefaultState());
    }

    try {
      await copyFile(fullPath, `${fullPath}.bak`);
      await rename(fullPath, `${fullPath}.invalid`);
    } catch {
      // ignore backup failures during recovery
    }

    return writeStateFile(worktree, stateFile, createDefaultState());
  }
}

export async function proposeCodeSwarmTransition(
  worktree: string,
  stateFile: string,
  nextPhase: Phase,
): Promise<CodeSwarmState> {
  const state = await readCodeSwarmState(worktree, stateFile);

  if (!validTransitions[state.phase].includes(nextPhase)) {
    throw new Error(`Invalid transition from ${state.phase} to ${nextPhase}`);
  }

  if (nextPhase === state.phase) {
    return writeStateFile(worktree, stateFile, {
      ...state,
      proposedNextPhase: null,
      confirmationPending: false,
    });
  }

  return writeStateFile(worktree, stateFile, {
    ...state,
    proposedNextPhase: nextPhase,
    confirmationPending: true,
  });
}

export async function approveCodeSwarmTransition(
  worktree: string,
  stateFile: string,
  metadata: { planSummary?: string; reviewFindings?: string[]; openIssues?: string[] } = {},
): Promise<CodeSwarmState> {
  const state = await readCodeSwarmState(worktree, stateFile);

  if (!state.confirmationPending || !state.proposedNextPhase) {
    throw new Error("No pending transition to approve");
  }

  if (
    state.phase === "review" &&
    state.proposedNextPhase === "plan" &&
    (metadata.reviewFindings?.length ?? state.lastReviewFindings.length) === 0
  ) {
    throw new Error("review -> plan requires review findings");
  }

  const summary =
    state.phase === "plan"
      ? metadata.planSummary ?? state.lastPlanSummary ?? "Plan approved"
      : state.phase === "review"
        ? metadata.reviewFindings?.join("; ") ??
          state.lastReviewFindings.join("; ") ??
          "Review approved"
        : `Implementation moved to ${state.proposedNextPhase}`;

  const nextState: CodeSwarmState = {
    ...state,
    phase: state.proposedNextPhase,
    proposedNextPhase: null,
    confirmationPending: false,
    lastPlanSummary: metadata.planSummary ?? state.lastPlanSummary,
    lastReviewFindings: metadata.reviewFindings ?? state.lastReviewFindings,
    openIssues: metadata.openIssues ?? state.openIssues,
    history: [
      ...state.history,
      {
        from: state.phase,
        to: state.proposedNextPhase,
        at: new Date().toISOString(),
        summary,
      },
    ],
  };

  return writeStateFile(worktree, stateFile, nextState);
}

export async function forceCodeSwarmPhase(
  worktree: string,
  stateFile: string,
  phase: Phase,
  summary: string,
): Promise<CodeSwarmState> {
  const state = await readCodeSwarmState(worktree, stateFile);

  if (!validTransitions[state.phase]?.includes(phase)) {
    throw new Error(`Invalid forced transition from ${state.phase} to ${phase}`);
  }

  return writeStateFile(worktree, stateFile, {
    ...state,
    phase,
    proposedNextPhase: null,
    confirmationPending: false,
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

export async function resetCodeSwarmState(
  worktree: string,
  stateFile: string,
): Promise<CodeSwarmState> {
  const fullPath = getStatePath(worktree, stateFile);

  try {
    await copyFile(fullPath, `${fullPath}.bak`);
  } catch {
    // no state yet
  }

  return writeStateFile(worktree, stateFile, createDefaultState());
}
