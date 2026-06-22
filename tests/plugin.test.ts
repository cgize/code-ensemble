import { describe, expect, it } from "vitest";

import codeSwarmPlugin from "../src/index";
import { createDefaultState } from "../src/state";
import { formatCompactionContext, formatStateSummary } from "../src/register";
import type { CodeSwarmState } from "../src/types";

describe("codeSwarmPlugin", () => {
  it("injects agents, commands, and tools", async () => {
    const plugin = await codeSwarmPlugin({ worktree: "/tmp/ferio-app" } as never, {});
    const cfg: Record<string, any> = {};

    plugin.config?.(cfg);

    expect(cfg.agent.orchestrator.model).toBe("opencode-go/deepseek-v4-flash");
    expect(cfg.agent.implementer.model).toBe("opencode-go/kimi-k2.7-code");
    expect(cfg.command["phase-status"].agent).toBe("orchestrator");
    expect(plugin.tool?.code_swarm_state).toBeDefined();
    expect(plugin.tool?.code_swarm_transition).toBeDefined();
  });

  it("exposes experimental chat system transform and session compacting hooks", async () => {
    const plugin = await codeSwarmPlugin({ worktree: "/tmp/ferio-app" } as never, {});

    expect(plugin["experimental.chat.system.transform"]).toBeDefined();
    expect(plugin["experimental.session.compacting"]).toBeDefined();
  });
});

describe("code-swarm prompt helpers", () => {
  it("formats runtime state for the orchestrator and compaction hooks", () => {
    const state: CodeSwarmState = {
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
    expect(formatCompactionContext(state)).toContain("Add regression coverage for approve-phase");
    expect(formatCompactionContext(state)).toContain("Plan approved");
  });
});
