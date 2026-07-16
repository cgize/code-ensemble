import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approveCodeEnsembleTransition,
  createDefaultState,
  forceCodeEnsemblePhase,
  proposeCodeEnsembleTransition,
  readCodeEnsembleState,
  resetCodeEnsembleState,
  setCodeEnsembleAutoLoop,
} from "../src/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }))),
  );
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function writeJsonState(root: string, state: unknown): Promise<void> {
  await mkdir(join(root, ".opencode", "state"), { recursive: true });
  await writeFile(
    join(root, ".opencode", "state", "code-ensemble.json"),
    JSON.stringify(state, null, 2),
    "utf8",
  );
}

describe("code-ensemble state", () => {
  it("creates the default state when the file does not exist", async () => {
    const root = await makeRoot("code-ensemble-state-");

    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json");

    expect(state.phase).toBe("plan");
    expect(state.confirmationPending).toBe(false);
    expect(state.history).toEqual([]);
    expect(state.autoLoop).toBe(false);
    expect(state.autoLoopMaxIterations).toBe(5);
    expect(state.loopIteration).toBe(0);
  });

  it("isolates sessions and migrates the global state once", async () => {
    const root = await makeRoot("code-ensemble-state-sessions-");
    await writeJsonState(root, { ...createDefaultState(), lastPlanSummary: "legacy" });

    const first = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {}, "session-a");
    const second = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {}, "session-b");

    expect(first.lastPlanSummary).toBe("legacy");
    expect(second.lastPlanSummary).toBe("");
    const stateFiles = await readdir(join(root, ".opencode", "state"));
    const migrated = stateFiles.find((entry) => entry.startsWith("code-ensemble.json.migrated."));
    expect(migrated).toBeDefined();
    expect(await readFile(join(root, ".opencode", "state", migrated!), "utf8")).toContain("legacy");
    await expect(readCodeEnsembleState(root, ".opencode/state/code-ensemble.json")).rejects.toThrow(/sessionID is required/);
  });

  it("prevents legacy internal calls from creating split state after session storage starts", async () => {
    const root = await makeRoot("code-ensemble-state-session-first-");
    await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {}, "session-a");
    await expect(readCodeEnsembleState(root, ".opencode/state/code-ensemble.json")).rejects.toThrow(/sessionID is required/);
    await expect(resetCodeEnsembleState(root, ".opencode/state/code-ensemble.json")).rejects.toThrow(/sessionID is required/);
  });

  it("serializes concurrent mutations in one session", async () => {
    const root = await makeRoot("code-ensemble-state-concurrency-");
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        forceCodeEnsemblePhase(
          root,
          ".opencode/state/code-ensemble.json",
          index % 2 === 0 ? "implement" : "review",
          `transition-${index}`,
          {},
          "session-a",
        ),
      ),
    );
    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {}, "session-a");
    expect(state.history).toHaveLength(20);
    expect(new Set(state.history.map((entry) => entry.summary)).size).toBe(20);
  });

  it("applies project defaults when the state file is created fresh", async () => {
    const root = await makeRoot("code-ensemble-state-defaults-");

    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {
      autoLoop: true,
      autoLoopMaxIterations: 8,
    });

    expect(state.autoLoop).toBe(true);
    expect(state.autoLoopMaxIterations).toBe(8);
  });

  it("normalizes legacy state files that do not have auto-loop fields", async () => {
    const root = await makeRoot("code-ensemble-state-legacy-");

    await writeJsonState(root, {
      phase: "plan",
      proposedNextPhase: null,
      confirmationPending: false,
      history: [],
      lastPlanSummary: "Legacy plan",
      lastReviewFindings: [],
      openIssues: [],
    });

    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {
      autoLoop: true,
      autoLoopMaxIterations: 8,
    });

    expect(state.autoLoop).toBe(true);
    expect(state.autoLoopMaxIterations).toBe(8);
    expect(state.loopIteration).toBe(0);

    const toggled = await setCodeEnsembleAutoLoop(
      root,
      ".opencode/state/code-ensemble.json",
      {
        enabled: true,
      },
      { autoLoop: true, autoLoopMaxIterations: 8 },
    );
    expect(toggled.autoLoop).toBe(true);
    expect(toggled.autoLoopMaxIterations).toBe(8);
  });

  it("proposes and approves a phase transition", async () => {
    const root = await makeRoot("code-ensemble-state-");

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement");
    const approved = await approveCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", {
      planSummary: "Plan approved by user",
      openIssues: ["Run implementation smoke test"],
    });

    expect(approved.phase).toBe("implement");
    expect(approved.confirmationPending).toBe(false);
    expect(approved.openIssues).toEqual(["Run implementation smoke test"]);
    expect(approved.history.at(-1)).toMatchObject({ from: "plan", to: "implement" });
  });

  it("backs up invalid JSON before resetting to defaults", async () => {
    const root = await makeRoot("code-ensemble-state-");

    await mkdir(join(root, ".opencode", "state"), { recursive: true });
    await writeFile(join(root, ".opencode", "state", "code-ensemble.json"), "not-json");

    const state = await resetCodeEnsembleState(root, ".opencode/state/code-ensemble.json");
    const stateFiles = await readdir(join(root, ".opencode", "state"));
    const backupName = stateFiles.find((entry) => entry.startsWith("code-ensemble.json.bak."));
    const backup = await readFile(join(root, ".opencode", "state", backupName!), "utf8");

    expect(state.phase).toBe("plan");
    expect(backup).toBe("not-json");
  });
});

describe("auto-loop mode", () => {
  it("applies project defaults when transition functions create a fresh state", async () => {
    const root = await makeRoot("code-ensemble-autoloop-fresh-");

    const state = await proposeCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      "implement",
      {},
      { autoLoop: true, autoLoopMaxIterations: 7 },
    );

    expect(state.phase).toBe("implement");
    expect(state.autoLoop).toBe(true);
    expect(state.autoLoopMaxIterations).toBe(7);
  });

  it("applies a phase transition immediately when auto-loop is on", async () => {
    const root = await makeRoot("code-ensemble-autoloop-");

    await setCodeEnsembleAutoLoop(root, ".opencode/state/code-ensemble.json", { enabled: true });
    const proposed = await proposeCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      "implement",
    );

    expect(proposed.phase).toBe("implement");
    expect(proposed.confirmationPending).toBe(false);
    expect(proposed.proposedNextPhase).toBeNull();
    expect(proposed.history.at(-1)).toMatchObject({
      from: "plan",
      to: "implement",
      summary: "Auto-loop: plan -> implement",
    });
  });

  it("applies a pending manual transition when auto-loop is enabled", async () => {
    const root = await makeRoot("code-ensemble-autoloop-pending-");

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", {
      planSummary: "Pending plan",
      openIssues: ["Run smoke tests"],
    });

    const state = await setCodeEnsembleAutoLoop(root, ".opencode/state/code-ensemble.json", { enabled: true });

    expect(state.phase).toBe("implement");
    expect(state.autoLoop).toBe(true);
    expect(state.confirmationPending).toBe(false);
    expect(state.proposedNextPhase).toBeNull();
    expect(state.lastPlanSummary).toBe("Pending plan");
    expect(state.openIssues).toEqual(["Run smoke tests"]);
    expect(state.pendingPlanSummary).toBe("");
    expect(state.pendingOpenIssues).toEqual([]);
    expect(state.history.at(-1)).toMatchObject({
      from: "plan",
      to: "implement",
      summary: "Auto-loop: plan -> implement",
    });
  });

  it("preserves transition metadata when auto-loop applies propose immediately", async () => {
    const root = await makeRoot("code-ensemble-autoloop-metadata-");

    await writeJsonState(root, createDefaultState({ autoLoop: true, autoLoopMaxIterations: 5 }));

    const state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", {
      planSummary: "Auto-approved implementation plan",
      openIssues: ["Run smoke tests"],
    });

    expect(state.phase).toBe("implement");
    expect(state.lastPlanSummary).toBe("Auto-approved implementation plan");
    expect(state.openIssues).toEqual(["Run smoke tests"]);
  });

  it("rejects auto-loop review -> plan without review findings", async () => {
    const root = await makeRoot("code-ensemble-autoloop-review-plan-");

    await writeJsonState(root, {
      ...createDefaultState({ autoLoop: true, autoLoopMaxIterations: 5 }),
      phase: "review",
    });

    await expect(
      proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "plan"),
    ).rejects.toThrow(/review -> plan requires review findings/);
  });

  it("allows auto-loop review -> plan when review findings exist", async () => {
    const root = await makeRoot("code-ensemble-autoloop-review-plan-findings-");

    await writeJsonState(root, {
      ...createDefaultState({ autoLoop: true, autoLoopMaxIterations: 5 }),
      phase: "review",
    });

    const state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "plan", {
      reviewFindings: ["Need a new plan for incompatible API change"],
    });

    expect(state.phase).toBe("plan");
    expect(state.lastReviewFindings).toEqual(["Need a new plan for incompatible API change"]);
  });

  it("resets the fix-cycle iteration counter on a fresh plan -> implement", async () => {
    const root = await makeRoot("code-ensemble-autoloop-");

    await writeJsonState(root, {
      ...createDefaultState({ autoLoop: true, autoLoopMaxIterations: 3 }),
      phase: "implement",
      loopIteration: 0,
    });

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "review");
    let state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json");
    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement");
    expect(state.loopIteration).toBe(1);
    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "review");
    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "plan", {
      reviewFindings: ["Planning reset requested after review"],
    });
    expect(state.phase).toBe("plan");
    expect(state.loopIteration).toBe(1);

    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement");
    expect(state.loopIteration).toBe(0);
  });

  it("enforces the iteration cap on the review -> implement fix cycle", async () => {
    const root = await makeRoot("code-ensemble-autoloop-cap-");

    await writeJsonState(root, {
      ...createDefaultState({ autoLoop: true, autoLoopMaxIterations: 2 }),
      phase: "implement",
      loopIteration: 0,
    });

    let state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "review");
    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement");
    expect(state.loopIteration).toBe(1);

    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "review");
    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement");
    expect(state.loopIteration).toBe(2);

    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "review");
    await expect(
      proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement"),
    ).rejects.toThrow(/Auto-loop iteration cap reached/);
  });

  it("does not enforce the cap on plan -> implement", async () => {
    const root = await makeRoot("code-ensemble-autoloop-cap-plan-");

    await writeJsonState(root, {
      ...createDefaultState({ autoLoop: true, autoLoopMaxIterations: 1 }),
      phase: "review",
      loopIteration: 1,
    });

    const state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "plan", {
      reviewFindings: ["Planning reset requested after review"],
    });
    expect(state.phase).toBe("plan");

    const next = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement");
    expect(next.phase).toBe("implement");
    expect(next.loopIteration).toBe(0);
  });

  it("disabling auto-loop falls back to requiring confirmation", async () => {
    const root = await makeRoot("code-ensemble-autoloop-off-");

    await setCodeEnsembleAutoLoop(root, ".opencode/state/code-ensemble.json", { enabled: true });
    await setCodeEnsembleAutoLoop(root, ".opencode/state/code-ensemble.json", { enabled: false });

    const proposed = await proposeCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      "implement",
    );

    expect(proposed.phase).toBe("plan");
    expect(proposed.confirmationPending).toBe(true);
    expect(proposed.proposedNextPhase).toBe("implement");
  });

  it("createDefaultState falls back to 5 for invalid autoLoopMaxIterations", () => {
    expect(createDefaultState({ autoLoopMaxIterations: 0 }).autoLoopMaxIterations).toBe(5);
    expect(createDefaultState({ autoLoopMaxIterations: -1 }).autoLoopMaxIterations).toBe(5);
    expect(createDefaultState({ autoLoopMaxIterations: NaN }).autoLoopMaxIterations).toBe(5);
    expect(createDefaultState({ autoLoopMaxIterations: 3.7 }).autoLoopMaxIterations).toBe(3);
  });

  it("normalizePersistedState falls back to default cap for invalid persisted autoLoopMaxIterations", async () => {
    const root = await makeRoot("code-ensemble-norm-cap-");

    await writeJsonState(root, {
      ...createDefaultState(),
      autoLoopMaxIterations: -3,
    });

    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {
      autoLoopMaxIterations: 7,
    });

    expect(state.autoLoopMaxIterations).toBe(7);
  });

  it("force-phase to plan resets the loop iteration counter", async () => {
    const root = await makeRoot("code-ensemble-autoloop-force-");

    await writeJsonState(root, {
      ...createDefaultState(),
      phase: "review",
      loopIteration: 4,
    });

    const state = await forceCodeEnsemblePhase(
      root,
      ".opencode/state/code-ensemble.json",
      "plan",
      "User reset",
    );

    expect(state.phase).toBe("plan");
    expect(state.loopIteration).toBe(0);
  });

  it("force-phase bypasses the normal transition graph", async () => {
    const root = await makeRoot("code-ensemble-force-direct-");
    const state = await forceCodeEnsemblePhase(
      root,
      ".opencode/state/code-ensemble.json",
      "review",
      "Direct command",
    );
    expect(state.phase).toBe("review");
  });

  it("force-phase to plan clears stale display summaries", async () => {
    const root = await makeRoot("code-ensemble-force-plan-display-");

    await writeJsonState(root, {
      ...createDefaultState(),
      phase: "review",
      lastPlanSummary: "Previous plan",
      lastReviewFindings: ["Previous finding"],
    });

    const state = await forceCodeEnsemblePhase(
      root,
      ".opencode/state/code-ensemble.json",
      "plan",
      "User reset",
    );

    expect(state.phase).toBe("plan");
    expect(state.lastPlanSummary).toBe("");
    expect(state.lastReviewFindings).toEqual([]);
  });

  it("reset applies config defaults instead of preserving previous cap", async () => {
    const root = await makeRoot("code-ensemble-autoloop-reset-cap-");

    await writeJsonState(root, {
      ...createDefaultState(),
      autoLoopMaxIterations: 15,
      loopIteration: 3,
    });

    const state = await resetCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {
      autoLoopMaxIterations: 7,
    });

    expect(state.autoLoopMaxIterations).toBe(7);
    expect(state.loopIteration).toBe(0);
  });
});

describe("pending transition metadata", () => {
  it("stores metadata from propose and carries it through approve", async () => {
    const root = await makeRoot("code-ensemble-pending-");

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", {
      planSummary: "Plan from propose",
      openIssues: ["Smoke test"],
    });
    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json");
    expect(state.pendingPlanSummary).toBe("Plan from propose");
    expect(state.pendingOpenIssues).toEqual(["Smoke test"]);

    const approved = await approveCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json");
    expect(approved.phase).toBe("implement");
    expect(approved.lastPlanSummary).toBe("Plan from propose");
    expect(approved.openIssues).toEqual(["Smoke test"]);
    expect(approved.pendingPlanSummary).toBe("");
    expect(approved.pendingOpenIssues).toEqual([]);
  });

  it("explicit approve metadata overrides pending metadata", async () => {
    const root = await makeRoot("code-ensemble-pending-override-");

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", {
      planSummary: "Pending plan",
    });

    const approved = await approveCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", {
      planSummary: "Explicit approve plan",
    });

    expect(approved.lastPlanSummary).toBe("Explicit approve plan");
  });

  it("force-phase clears pending metadata", async () => {
    const root = await makeRoot("code-ensemble-pending-force-");

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", {
      planSummary: "Will be cleared",
    });
    let state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json");
    expect(state.pendingPlanSummary).toBe("Will be cleared");

    state = await forceCodeEnsemblePhase(
      root,
      ".opencode/state/code-ensemble.json",
      "implement",
      "Forced",
    );

    expect(state.pendingPlanSummary).toBe("");
    expect(state.pendingOpenIssues).toEqual([]);
  });

  it("re-proposing a manual transition without metadata clears stale pending metadata", async () => {
    const root = await makeRoot("code-ensemble-pending-repropose-");

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", {
      planSummary: "Old pending plan",
      openIssues: ["Old issue"],
    });

    let state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement");
    expect(state.pendingPlanSummary).toBe("");
    expect(state.pendingOpenIssues).toEqual([]);

    state = await approveCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json");
    expect(state.lastPlanSummary).toBe("");
    expect(state.openIssues).toEqual([]);
  });

  it("no-op propose (same phase) clears pending metadata", async () => {
    const root = await makeRoot("code-ensemble-pending-noop-");

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", {
      planSummary: "Will be cleared",
    });
    let state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json");
    expect(state.pendingPlanSummary).toBe("Will be cleared");

    state = await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "plan");

    expect(state.pendingPlanSummary).toBe("");
    expect(state.pendingOpenIssues).toEqual([]);
    expect(state.confirmationPending).toBe(false);
  });
});

describe("reviewToPlanOnlyWithFindings flag", () => {
  it("does not treat stale lastReviewFindings as findings for a new review", async () => {
    const root = await makeRoot("code-ensemble-rpf-stale-findings-");

    await writeJsonState(root, {
      ...createDefaultState(),
      phase: "review",
      lastReviewFindings: ["Old blocking issue"],
    });

    await expect(
      proposeCodeEnsembleTransition(
        root,
        ".opencode/state/code-ensemble.json",
        "plan",
        {},
        { reviewToPlanOnlyWithFindings: true },
      ),
    ).rejects.toThrow(/review -> plan requires review findings/);
  });

  it("rejects review -> plan without findings when flag is true (propose path)", async () => {
    const root = await makeRoot("code-ensemble-rpf-true-propose-");

    await writeJsonState(root, {
      ...createDefaultState(),
      phase: "review",
    });

    await expect(
      proposeCodeEnsembleTransition(
        root,
        ".opencode/state/code-ensemble.json",
        "plan",
        {},
        { reviewToPlanOnlyWithFindings: true },
      ),
    ).rejects.toThrow(/review -> plan requires review findings/);
  });

  it("rejects review -> plan without findings when flag is true (approve path)", async () => {
    const root = await makeRoot("code-ensemble-rpf-true-");

    await writeJsonState(root, {
      ...createDefaultState(),
      phase: "review",
      proposedNextPhase: "plan",
      confirmationPending: true,
    });

    await expect(
      approveCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", {}, { reviewToPlanOnlyWithFindings: true }),
    ).rejects.toThrow(/review -> plan requires review findings/);
  });

  it("allows review -> plan without findings when flag is false (auto-loop path)", async () => {
    const root = await makeRoot("code-ensemble-rpf-false-");

    await writeJsonState(root, {
      ...createDefaultState({ autoLoopMaxIterations: 5 }),
      phase: "review",
      autoLoop: true,
    });

    const state = await proposeCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      "plan",
      {},
      { reviewToPlanOnlyWithFindings: false },
    );

    expect(state.phase).toBe("plan");
  });

  it("allows review -> plan without findings when flag is false (approve path)", async () => {
    const root = await makeRoot("code-ensemble-rpf-false-approve-");

    await writeJsonState(root, {
      ...createDefaultState(),
      phase: "review",
    });

    await proposeCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      "plan",
      {},
      { reviewToPlanOnlyWithFindings: false },
    );

    const state = await approveCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      {},
      { reviewToPlanOnlyWithFindings: false },
    );

    expect(state.phase).toBe("plan");
  });

  it("always allows review -> plan with findings regardless of flag (auto-loop path)", async () => {
    const root = await makeRoot("code-ensemble-rpf-findings-");

    await writeJsonState(root, {
      ...createDefaultState({ autoLoopMaxIterations: 5 }),
      phase: "review",
      autoLoop: true,
    });

    const state = await proposeCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      "plan",
      { reviewFindings: ["Need new plan"] },
      { reviewToPlanOnlyWithFindings: true },
    );

    expect(state.phase).toBe("plan");
    expect(state.lastReviewFindings).toEqual(["Need new plan"]);
  });

  it("cleans stale review findings and records a non-empty summary for a clean manual review", async () => {
    const root = await makeRoot("code-ensemble-rpf-clean-review-");

    await writeJsonState(root, {
      ...createDefaultState(),
      phase: "review",
      lastReviewFindings: ["Old blocking issue"],
    });

    await proposeCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      "plan",
      { reviewFindings: [] },
      { reviewToPlanOnlyWithFindings: false },
    );

    const state = await approveCodeEnsembleTransition(
      root,
      ".opencode/state/code-ensemble.json",
      {},
      { reviewToPlanOnlyWithFindings: false },
    );

    expect(state.lastReviewFindings).toEqual([]);
    expect(state.history.at(-1)?.summary).toBe("Review approved");
  });
});

describe("normalizePersistedState edge cases", () => {
  it("rejects inherited object keys as phases", async () => {
    const root = await makeRoot("code-ensemble-norm-inherited-phase-");
    await writeJsonState(root, { ...createDefaultState(), phase: "constructor" });
    expect((await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json")).phase).toBe("plan");
  });

  it("rejects oversized state before parsing it", async () => {
    const root = await makeRoot("code-ensemble-norm-oversized-");
    await mkdir(join(root, ".opencode", "state"), { recursive: true });
    await writeFile(join(root, ".opencode", "state", "code-ensemble.json"), `{"padding":"${"x".repeat(1_100_000)}"}`);
    await expect(readCodeEnsembleState(root, ".opencode/state/code-ensemble.json")).rejects.toThrow(/exceeds/);
  });

  it("does not write a normalized state that exceeds the read limit", async () => {
    const root = await makeRoot("code-ensemble-state-write-limit-");
    const largeList = Array.from({ length: 100 }, (_, index) => `${index}-${"x".repeat(4_000)}`);
    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", { openIssues: largeList });
    await approveCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json");
    await forceCodeEnsemblePhase(root, ".opencode/state/code-ensemble.json", "review", "Review");

    await expect(proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement", {
      reviewFindings: largeList,
      openIssues: largeList,
    })).rejects.toThrow(/exceeds/);
    expect((await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json")).phase).toBe("review");
  });

  it("drops proposedNextPhase when it is not a valid transition from the current phase", async () => {
    const root = await makeRoot("code-ensemble-norm-transition-");

    await writeJsonState(root, {
      phase: "plan",
      proposedNextPhase: "review",
      confirmationPending: true,
    });

    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json");
    expect(state.phase).toBe("plan");
    expect(state.proposedNextPhase).toBeNull();
    expect(state.confirmationPending).toBe(false);
  });

  it("keeps proposedNextPhase when it is a valid transition", async () => {
    const root = await makeRoot("code-ensemble-norm-valid-");

    await writeJsonState(root, {
      phase: "plan",
      proposedNextPhase: "implement",
      confirmationPending: true,
    });

    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json");
    expect(state.phase).toBe("plan");
    expect(state.proposedNextPhase).toBe("implement");
  });
});
