import { describe, expect, it } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import codeEnsemblePlugin, { codeEnsemblePlugin as pluginModule } from "../src/index";
import { createDefaultState } from "../src/state";
import { formatCompactionContext, formatStateSummary } from "../src/register";
import type { CodeEnsembleState } from "../src/types";

const server = pluginModule.server;
type PermissionAction = "allow" | "ask" | "deny";
type PermissionRule = PermissionAction | Record<string, PermissionAction>;
type AgentPermission = Record<string, PermissionRule>;

function getAgentPermission(cfg: Config, role: string): AgentPermission {
  return cfg.agent?.[role]?.permission as unknown as AgentPermission;
}

describe("codeEnsemblePlugin", () => {
  it("exports a v1 plugin shape (default = { id, server }) for OpenCode npm loading", () => {
    expect(typeof server).toBe("function");
    expect(codeEnsemblePlugin).toMatchObject({ id: "@cgize/code-ensemble" });
    expect(codeEnsemblePlugin.server).toBe(server);
  });

  it("falls back when npm plugin input omits root directory", async () => {
    const plugin = await server({} as never, {});
    const cfg: Config = {};

    plugin.config?.(cfg);

    expect(cfg.agent?.director).toBeDefined();
    expect(cfg.command?.["phase-status"]).toBeDefined();
  });

  it("resolves project.directory when root directory is absent", async () => {
    const plugin = await server({ project: { directory: "/tmp/ferio-app" } } as never, {});
    const cfg: Config = {};

    plugin.config?.(cfg);

    expect(cfg.agent?.director?.model).toBe("opencode-go/minimax-m3");
  });

  it("resolves project.worktree when loaded by opencode npm plugin", async () => {
    const plugin = await server({ project: { worktree: "/tmp/ferio-app" } } as never, {});
    const cfg: Config = {};

    plugin.config?.(cfg);

    expect(cfg.agent?.director?.model).toBe("opencode-go/minimax-m3");
  });

  it("injects agents, commands, and tools", async () => {
    const plugin = await server({ directory: "/tmp/ferio-app" } as never, {});
    const cfg: Config = {};

    plugin.config?.(cfg);

    expect(cfg.agent?.director?.model).toBe("opencode-go/minimax-m3");
    expect(cfg.agent?.visualizer?.model).toBe("opencode-go/kimi-k2.7-code");
    expect(cfg.agent?.planner?.model).toBe("openai/gpt-5.6-terra");
    expect(cfg.agent?.architect?.model).toBe("openai/gpt-5.6-sol");
    expect(cfg.agent?.implementer?.model).toBe("opencode-go/glm-5.2");
    expect(cfg.agent?.["code-ensemble-planner-fallback"]?.model).toBe("opencode-go/glm-5.2");
    expect(cfg.agent?.["code-ensemble-architect-fallback"]?.hidden).toBe(true);
    expect(cfg.agent?.architect?.fallbacks).toBeUndefined();
    expect(cfg.command?.["phase-status"]?.agent).toBe("director");
    expect(cfg.command?.["auto-loop"]?.agent).toBe("director");
    expect(plugin.tool?.code_ensemble_state).toBeDefined();
    expect(plugin.tool?.code_ensemble_transition).toBeDefined();
    expect(plugin.tool?.code_ensemble_save_artifact).toBeDefined();
    expect(plugin.tool?.code_ensemble_auto_loop).toBeDefined();
    expect(plugin.tool?.code_ensemble_delegate).toBeDefined();
    expect(plugin["experimental.provider.small_model"]).toBeUndefined();
  });

  it("assigns least-privilege permissions to every subagent role", async () => {
    const plugin = await server({ directory: "/tmp/ferio-app" } as never, {});
    const cfg: Config = {};

    plugin.config?.(cfg);

    const roles = ["explorer", "researcher", "visualizer", "planner", "architect", "implementer", "reviewer", "tester"];
    for (const role of roles) {
      expect(getAgentPermission(cfg, role)).toMatchObject({
        "*": "deny",
        task: "deny",
        external_directory: "deny",
        todowrite: "deny",
        question: "deny",
        "code_ensemble_*": "deny",
      });
    }

    expect(getAgentPermission(cfg, "explorer")).toMatchObject({
      edit: "deny",
      bash: "deny",
      glob: "allow",
      grep: "allow",
      lsp: "allow",
      webfetch: "deny",
      skill: "deny",
    });
    expect(getAgentPermission(cfg, "researcher")).toMatchObject({
      edit: "deny",
      bash: "deny",
      webfetch: "allow",
      websearch: "allow",
      lsp: "deny",
      skill: "allow",
    });
    expect(getAgentPermission(cfg, "visualizer")).toMatchObject({
      edit: "deny",
      bash: "deny",
      glob: "deny",
      grep: "deny",
      skill: "allow",
    });
    expect(getAgentPermission(cfg, "planner")).toMatchObject({
      edit: "deny",
      bash: "deny",
      read: { "*": "allow", "*.env": "deny", "*.env.example": "allow" },
      lsp: "allow",
      skill: "allow",
    });
    expect(getAgentPermission(cfg, "architect")).toMatchObject({
      edit: "deny",
      bash: "deny",
      webfetch: "allow",
      websearch: "allow",
      skill: "allow",
    });
    expect(getAgentPermission(cfg, "implementer")).toMatchObject({
      edit: { "*": "allow", "*.env": "ask", "*.env.example": "allow" },
      bash: { "*": "allow", "git *": "deny", "git diff*": "allow", "npm publish*": "deny" },
      skill: "allow",
    });
    expect(getAgentPermission(cfg, "reviewer")).toMatchObject({
      edit: "deny",
      bash: { "*": "deny", "git status*": "allow", "git diff*": "allow" },
      webfetch: "allow",
      websearch: "allow",
      skill: "allow",
    });
    expect(getAgentPermission(cfg, "tester")).toMatchObject({
      edit: "deny",
      bash: { "*": "allow", "git *": "deny", "npm install*": "deny", "cargo install*": "deny" },
      skill: "allow",
    });

    expect(getAgentPermission(cfg, "code-ensemble-planner-fallback")).toEqual(getAgentPermission(cfg, "planner"));
    expect(getAgentPermission(cfg, "code-ensemble-architect-fallback")).toEqual(getAgentPermission(cfg, "architect"));
  });

  it("uses a renamed planner in quota-aware delegation", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-ensemble-delegate-"));
    const agents: string[] = [];
    try {
      await writeFile(
        resolve(root, "code-ensemble.json"),
        JSON.stringify({ subagents: { rename: { planner: "strategist" } } }),
      );
      const plugin = await server({
        directory: root,
        client: {
          session: {
            create: async () => ({ data: { id: "child-session" } }),
            prompt: async (input: { body: { agent: string } }) => {
              agents.push(input.body.agent);
              return { data: { info: {}, parts: [{ type: "text", text: "plan" }] } };
            },
          },
        },
      } as never, {});

      const result = await plugin.tool!.code_ensemble_delegate!.execute(
        { role: "planner", description: "Plan change", prompt: "Inspect the repository" },
        { agent: "director", sessionID: "parent" } as never,
      );

      expect(agents).toEqual(["strategist"]);
      expect(result).toMatchObject({ metadata: { usedFallback: false, model: "openai/gpt-5.6-terra" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("saves and reads artifacts via code_ensemble_save_artifact", async () => {
    const plugin = await server({ directory: "/tmp/ferio-app" } as never, {});
    const artifactTool = plugin.tool?.code_ensemble_save_artifact;
    expect(artifactTool).toBeDefined();

    const saveResult = await artifactTool!.execute({
      action: "save",
      name: "test-plan",
      content: "- [ ] task 1\n- [x] task 2",
    }, { directory: "/tmp/ferio-app" } as never);
    expect(JSON.parse(saveResult as string).saved).toContain("test-plan.md");

    const readResult = await artifactTool!.execute({
      action: "read",
      name: "test-plan",
    }, { directory: "/tmp/ferio-app" } as never);
    const read = JSON.parse(readResult as string);
    expect(read.content).toContain("- [ ] task 1");

    const missingResult = await artifactTool!.execute({
      action: "read",
      name: "nonexistent",
    }, { directory: "/tmp/ferio-app" } as never);
    expect(JSON.parse(missingResult as string).error).toBeDefined();
  });

  it("toggles auto-loop via the code_ensemble_auto_loop tool", async () => {
    const plugin = await server({ directory: "/tmp/ferio-app" } as never, {});
    const tool = plugin.tool?.code_ensemble_auto_loop;
    expect(tool).toBeDefined();

    const on = await tool!.execute({ enabled: true }, { directory: "/tmp/ferio-app" } as never);
    const onState = JSON.parse(on as string);
    expect(onState.autoLoop).toBe(true);

    const off = await tool!.execute({ enabled: false }, { directory: "/tmp/ferio-app" } as never);
    const offState = JSON.parse(off as string);
    expect(offState.autoLoop).toBe(false);
  });

  it("exposes experimental chat system transform and session compacting hooks", async () => {
    const plugin = await server({ directory: "/tmp/ferio-app" } as never, {});

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
