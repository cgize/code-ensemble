import { describe, expect, it } from "vitest";

import codeEnsemblePlugin from "../src/index";
import { createDefaultState } from "../src/state";
import { formatCompactionContext, formatStateSummary } from "../src/register";
import type { CodeEnsembleState } from "../src/types";

describe("codeEnsemblePlugin", () => {
  it("injects agents, commands, and tools", async () => {
    const plugin = await codeEnsemblePlugin({ worktree: "/tmp/ferio-app" } as never, {});
    const cfg: Record<string, any> = {};

    plugin.config?.(cfg);

    expect(cfg.agent.director.model).toBe("opencode-go/deepseek-v4-pro");
    expect(cfg.agent.visualizer.model).toBe("opencode-go/mimo-v2.5");
    expect(cfg.agent.architect.model).toBe("openai/gpt-5.5");
    expect(cfg.agent.implementer.model).toBe("opencode-go/deepseek-v4-pro");
    expect(cfg.agent.architect.fallbacks).toEqual(["opencode-go/deepseek-v4-pro"]);
    expect(cfg.command["phase-status"].agent).toBe("director");
    expect(cfg.command["auto-loop"].agent).toBe("director");
    expect(plugin.tool?.code_ensemble_state).toBeDefined();
    expect(plugin.tool?.code_ensemble_transition).toBeDefined();
    expect(plugin.tool?.code_ensemble_save_artifact).toBeDefined();
    expect(plugin.tool?.code_ensemble_auto_loop).toBeDefined();
  });

  it("saves and reads artifacts via code_ensemble_save_artifact", async () => {
    const plugin = await codeEnsemblePlugin({ worktree: "/tmp/ferio-app" } as never, {});
    const artifactTool = plugin.tool?.code_ensemble_save_artifact;
    expect(artifactTool).toBeDefined();

    const saveResult = await artifactTool!.execute({
      action: "save",
      name: "test-plan",
      content: "- [ ] task 1\n- [x] task 2",
    }, { worktree: "/tmp/ferio-app" } as never);
    expect(JSON.parse(saveResult as string).saved).toContain("test-plan.md");

    const readResult = await artifactTool!.execute({
      action: "read",
      name: "test-plan",
    }, { worktree: "/tmp/ferio-app" } as never);
    const read = JSON.parse(readResult as string);
    expect(read.content).toContain("- [ ] task 1");

    const missingResult = await artifactTool!.execute({
      action: "read",
      name: "nonexistent",
    }, { worktree: "/tmp/ferio-app" } as never);
    expect(JSON.parse(missingResult as string).error).toBeDefined();
  });

  it("toggles auto-loop via the code_ensemble_auto_loop tool", async () => {
    const plugin = await codeEnsemblePlugin({ worktree: "/tmp/ferio-app" } as never, {});
    const tool = plugin.tool?.code_ensemble_auto_loop;
    expect(tool).toBeDefined();

    const on = await tool!.execute({ enabled: true }, { worktree: "/tmp/ferio-app" } as never);
    const onState = JSON.parse(on as string);
    expect(onState.autoLoop).toBe(true);

    const off = await tool!.execute({ enabled: false }, { worktree: "/tmp/ferio-app" } as never);
    const offState = JSON.parse(off as string);
    expect(offState.autoLoop).toBe(false);
  });

  it("exposes experimental chat system transform and session compacting hooks", async () => {
    const plugin = await codeEnsemblePlugin({ worktree: "/tmp/ferio-app" } as never, {});

    expect(plugin["experimental.chat.system.transform"]).toBeDefined();
    expect(plugin["experimental.session.compacting"]).toBeDefined();
  });
});

describe("code-ensemble prompt helpers", () => {
  it("formats runtime state for the director and compaction hooks", () => {
    const state: CodeEnsembleState = {
      ...createDefaultState(),
      phase: "review",
      proposedNextPhase: "implement",
      confirmationPending: true,
      lastPlanSummary: "Implement search state management",
      lastReviewFindings: ["Missing test for rejected transition"],
      openIssues: ["Add regression coverage for approve-phase"],
      history: [
        { from: "plan", to: "implement", at: "2026-06-21T00:00:00.000Z", summary: "Plan approved" },
      ],
    };

    expect(formatStateSummary(state)).toContain("Current phase: review");
    expect(formatStateSummary(state)).toContain("Pending phase: implement");
    expect(formatStateSummary(state)).toContain("Auto-loop: off");
    expect(formatCompactionContext(state)).toContain("Add regression coverage for approve-phase");
    expect(formatCompactionContext(state)).toContain("Plan approved");
  });

  it("includes auto-loop status in the state summary when enabled", () => {
    const state: CodeEnsembleState = {
      ...createDefaultState({ autoLoopMaxIterations: 3 }),
      phase: "review",
      autoLoop: true,
      loopIteration: 2,
    };

    expect(formatStateSummary(state)).toContain("Auto-loop: on (iteration 2/3)");
  });

  it("shows pending transition metadata in the state summary when confirmation is pending", () => {
    const state: CodeEnsembleState = {
      ...createDefaultState(),
      phase: "plan",
      proposedNextPhase: "implement",
      confirmationPending: true,
      pendingPlanSummary: "Plan awaiting approval",
      pendingOpenIssues: ["Run smoke tests"],
    };

    const summary = formatStateSummary(state);
    expect(summary).toContain("Pending transition metadata:");
    expect(summary).toContain("Plan summary: Plan awaiting approval");
    expect(summary).toContain("Open issues: Run smoke tests");
  });
});
