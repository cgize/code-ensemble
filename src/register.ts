import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { tool, type Plugin } from "@opencode-ai/plugin";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";

import { buildCommandDefinitions } from "./commands.js";
import { resolveCodeEnsembleConfig } from "./overrides.js";
import {
  approveCodeEnsembleTransition,
  forceCodeEnsemblePhase,
  proposeCodeEnsembleTransition,
  readCodeEnsembleState,
  resetCodeEnsembleState,
  setCodeEnsembleAutoLoop,
} from "./state.js";
import type { CodeEnsemblePluginOptions, CodeEnsembleState, ResolvedCodeEnsembleConfig, RoleName } from "./types.js";

export function formatStateSummary(state: CodeEnsembleState): string {
  const issues =
    state.openIssues.length > 0
      ? state.openIssues.map((issue) => `- ${issue}`).join("\n")
      : "- none";
  const findings =
    state.lastReviewFindings.length > 0
      ? state.lastReviewFindings.map((finding) => `- ${finding}`).join("\n")
      : "- none";

  return [
    `Current phase: ${state.phase}`,
    `Pending phase: ${state.proposedNextPhase ?? "none"}`,
    `Confirmation pending: ${state.confirmationPending ? "yes" : "no"}`,
    `Auto-loop: ${state.autoLoop ? `on (iteration ${state.loopIteration}/${state.autoLoopMaxIterations})` : "off"}`,
    `Last plan summary: ${state.lastPlanSummary || "none"}`,
    `Last review findings:\n${findings}`,
    `Open issues:\n${issues}`,
    ...(state.confirmationPending && state.proposedNextPhase
      ? [
          `Pending transition metadata:`,
          `  Plan summary: ${state.pendingPlanSummary || "none"}`,
          `  Review findings: ${state.pendingReviewFindings.length > 0 ? state.pendingReviewFindings.join("; ") : "none"}`,
          `  Open issues: ${state.pendingOpenIssues.length > 0 ? state.pendingOpenIssues.join("; ") : "none"}`,
        ]
      : []),
  ].join("\n");
}

export function formatCompactionContext(state: CodeEnsembleState): string {
  const recentHistory =
    state.history
      .slice(-3)
      .map((entry) => `- ${entry.from} -> ${entry.to} @ ${entry.at}: ${entry.summary}`)
      .join("\n") || "- none";

  return [
    "## Code Ensemble Runtime State",
    formatStateSummary(state),
    "Recent transitions:",
    recentHistory,
  ].join("\n");
}

type EnsembleSubagent = Exclude<RoleName, "director">;

function buildAgentDefinitions(config: ResolvedCodeEnsembleConfig) {
  const getAgentName = (role: EnsembleSubagent) => config.renamedSubagents[role] ?? role;

  const isDisabled = (role: EnsembleSubagent) => config.disabledSubagents.includes(role);

  const agentDefinitions: Record<string, unknown> = {
    director: {
      description: "Coordinates the code-ensemble workflow across plan, implement, and review.",
      mode: config.roles.director.mode,
      model: config.roles.director.model,
      variant: config.roles.director.variant,
      prompt: config.roles.director.promptText,
      permission: {
        edit: "deny",
        bash: "deny",
        task: {
          "*": "deny",
          [getAgentName("explorer")]: isDisabled("explorer") ? "deny" : "allow",
          [getAgentName("planner")]: isDisabled("planner") ? "deny" : "allow",
          [getAgentName("architect")]: isDisabled("architect") ? "deny" : "allow",
          [getAgentName("implementer")]: isDisabled("implementer") ? "deny" : "allow",
          [getAgentName("reviewer")]: isDisabled("reviewer") ? "deny" : "allow",
          [getAgentName("tester")]: isDisabled("tester") ? "deny" : "allow",
          [getAgentName("researcher")]: isDisabled("researcher") ? "deny" : "allow",
          [getAgentName("visualizer")]: isDisabled("visualizer") ? "deny" : "allow",
        },
      },
    },
  };

  if (!isDisabled("explorer")) {
    agentDefinitions[getAgentName("explorer")] = {
      description: "Fast read-only codebase explorer.",
      mode: config.roles.explorer.mode,
      model: config.roles.explorer.model,
      variant: config.roles.explorer.variant,
      prompt: config.roles.explorer.promptText,
      permission: { edit: "deny", bash: "deny" },
    };
  }

  if (!isDisabled("researcher")) {
    agentDefinitions[getAgentName("researcher")] = {
      description: "External docs and dependency researcher.",
      mode: config.roles.researcher.mode,
      model: config.roles.researcher.model,
      variant: config.roles.researcher.variant,
      prompt: config.roles.researcher.promptText,
      permission: { edit: "deny", bash: "deny", webfetch: "allow" },
    };
  }

  if (!isDisabled("visualizer")) {
    agentDefinitions[getAgentName("visualizer")] = {
      description: "Vision specialist for screenshots, diagrams, and image attachments.",
      mode: config.roles.visualizer.mode,
      model: config.roles.visualizer.model,
      variant: config.roles.visualizer.variant,
      prompt: config.roles.visualizer.promptText,
      permission: { edit: "deny", bash: "deny" },
    };
  }

  if (!isDisabled("planner")) {
    agentDefinitions[getAgentName("planner")] = {
      description: "Planning specialist for the plan phase.",
      mode: config.roles.planner.mode,
      model: config.roles.planner.model,
      variant: config.roles.planner.variant,
      prompt: config.roles.planner.promptText,
      permission: { edit: "deny", bash: "deny" },
      fallbacks: config.fallbacks.planner,
    };
  }

  if (!isDisabled("architect")) {
    agentDefinitions[getAgentName("architect")] = {
      description: "Critical decision specialist for architecture and high-risk changes.",
      mode: config.roles.architect.mode,
      model: config.roles.architect.model,
      variant: config.roles.architect.variant,
      prompt: config.roles.architect.promptText,
      permission: { edit: "deny", bash: "deny" },
      fallbacks: config.fallbacks.architect,
    };
  }

  if (!isDisabled("implementer")) {
    agentDefinitions[getAgentName("implementer")] = {
      description: "Implementation specialist for the implement phase.",
      mode: config.roles.implementer.mode,
      model: config.roles.implementer.model,
      variant: config.roles.implementer.variant,
      prompt: config.roles.implementer.promptText,
      permission: { edit: "allow", bash: "allow" },
    };
  }

  if (!isDisabled("reviewer")) {
    agentDefinitions[getAgentName("reviewer")] = {
      description: "Read-only review specialist for the review phase.",
      mode: config.roles.reviewer.mode,
      model: config.roles.reviewer.model,
      variant: config.roles.reviewer.variant,
      prompt: config.roles.reviewer.promptText,
      permission: { edit: "deny", bash: "ask" },
    };
  }

  if (!isDisabled("tester")) {
    agentDefinitions[getAgentName("tester")] = {
      description: "Verification specialist for targeted checks.",
      mode: config.roles.tester.mode,
      model: config.roles.tester.model,
      variant: config.roles.tester.variant,
      prompt: config.roles.tester.promptText,
      permission: { edit: "deny", bash: "allow" },
    };
  }

  return agentDefinitions;
}

export const codeEnsemblePlugin: Plugin = async ({ directory }, options = {}) => {
  const config = resolveCodeEnsembleConfig(directory, options as CodeEnsemblePluginOptions);

  const stateDefaults = {
    autoLoop: config.transitions.autoLoop,
    autoLoopMaxIterations: config.transitions.autoLoopMaxIterations,
    reviewToPlanOnlyWithFindings: config.transitions.reviewToPlanOnlyWithFindings,
  };

  return {
    config: async (cfg) => {
      cfg.agent ??= {};
      cfg.command ??= {};
      Object.assign(cfg.agent, buildAgentDefinitions(config));
      Object.assign(cfg.command, buildCommandDefinitions(config));
    },
    tool: {
      code_ensemble_state: tool({
        description: "Read or reset the code-ensemble state for the current project.",
        args: {
          action: tool.schema.enum(["get", "reset"]),
        },
        async execute(args) {
          if (args.action === "reset") {
            const state = await resetCodeEnsembleState(directory, config.stateFile, stateDefaults);
            return JSON.stringify(state);
          }

          const state = await readCodeEnsembleState(directory, config.stateFile, stateDefaults);
          return JSON.stringify(state);
        },
      }),
      code_ensemble_transition: tool({
        description: "Propose, approve, or force a code-ensemble phase transition.",
        args: {
          action: tool.schema.enum(["propose", "approve", "force"]),
          phase: tool.schema.enum(["plan", "implement", "review"]).optional(),
          summary: tool.schema.string().optional(),
          planSummary: tool.schema.string().optional(),
          reviewFindings: tool.schema.array(tool.schema.string()).optional(),
          openIssues: tool.schema.array(tool.schema.string()).optional(),
        },
        async execute(args) {
          if (args.action === "propose") {
            if (!args.phase) {
              return JSON.stringify({ error: "phase is required for propose action" });
            }
            const state = await proposeCodeEnsembleTransition(
              directory,
              config.stateFile,
              args.phase,
              {
                planSummary: args.planSummary,
                reviewFindings: args.reviewFindings,
                openIssues: args.openIssues,
              },
              stateDefaults,
            );
            return JSON.stringify(state);
          }

          if (args.action === "approve") {
            const state = await approveCodeEnsembleTransition(
              directory,
              config.stateFile,
              {
                planSummary: args.planSummary,
                reviewFindings: args.reviewFindings,
                openIssues: args.openIssues,
              },
              stateDefaults,
            );
            return JSON.stringify(state);
          }

          if (!args.phase) {
            return JSON.stringify({ error: "phase is required for force action" });
          }
          const state = await forceCodeEnsemblePhase(
            directory,
            config.stateFile,
            args.phase,
            args.summary ?? `Forced by user to ${args.phase}`,
            stateDefaults,
          );
          return JSON.stringify(state);
        },
      }),
      code_ensemble_auto_loop: tool({
        description:
          "Enable or disable fully automatic full-loop mode. When enabled, every proposed phase transition is applied immediately without waiting for user confirmation. The director continues plan -> implement -> review and loops through review -> implement for BLOCKING findings until the iteration cap is reached or the work is clean. The iteration cap is set in code-ensemble.json and cannot be changed at runtime.",
        args: {
          enabled: tool.schema.boolean().describe("Whether to turn auto-loop on or off."),
        },
        async execute(args) {
          const state = await setCodeEnsembleAutoLoop(
            directory,
            config.stateFile,
            { enabled: args.enabled },
            stateDefaults,
          );
          return JSON.stringify(state);
        },
      }),
      code_ensemble_save_artifact: tool({
        description: "Save or read a markdown artifact under .code-ensemble/artifacts/. Use after planner returns a plan to persist it. Use 'read' to load it back for incremental updates (e.g. checking off completed items).",
        args: {
          action: tool.schema.enum(["save", "read"]).describe("'save' to persist content, 'read' to load existing artifact"),
          name: tool.schema.string().describe("File name without extension (e.g. 'search-refactor-plan')"),
          content: tool.schema.string().optional().describe("Markdown content (required for 'save')"),
          phase: tool.schema.enum(["plan", "implement", "review"]).optional().describe("Phase for subdirectory grouping"),
        },
        async execute(args, ctx) {
          const dir = args.phase
            ? resolve(ctx.directory, ".code-ensemble", "artifacts", args.phase)
            : resolve(ctx.directory, ".code-ensemble", "artifacts");
          const filePath = resolve(dir, `${args.name}.md`);

          if (args.action === "read") {
            if (!existsSync(filePath)) {
              return JSON.stringify({ error: `Artifact not found: ${filePath}` });
            }
            const content = readFileSync(filePath, "utf8");
            return JSON.stringify({ path: filePath, content });
          }

          if (!args.content) {
            return JSON.stringify({ error: "content is required for save action" });
          }
          mkdirSync(dir, { recursive: true });
          writeFileSync(filePath, args.content, "utf8");
          return JSON.stringify({ saved: filePath });
        },
      }),
      code_ensemble_summarize: tool({
        description: "Generate a session summary and suggested git commit message from the current plan artifacts and phase state.",
        args: {},
        async execute(_args, ctx) {
          const state = await readCodeEnsembleState(ctx.directory, config.stateFile, stateDefaults);
          const artifactsDir = resolve(ctx.directory, ".code-ensemble", "artifacts");
          const artifactContents: { path: string; content: string }[] = [];

          function walk(dir: string) {
            if (!existsSync(dir)) return;
            for (const entry of readdirSync(dir)) {
              const full = resolve(dir, entry);
              if (statSync(full).isDirectory()) {
                walk(full);
              } else if (entry.endsWith(".md")) {
                artifactContents.push({
                  path: relative(ctx.directory, full),
                  content: readFileSync(full, "utf8"),
                });
              }
            }
          }
          walk(artifactsDir);

          const completedTasks = artifactContents
            .flatMap((a) => [...a.content.matchAll(/- \[x\] (.+)/g)])
            .map((m) => m[1])
            .filter((t): t is string => t != null);
          const pendingTasks = artifactContents
            .flatMap((a) => [...a.content.matchAll(/- \[ \] (.+)/g)])
            .map((m) => m[1])
            .filter((t): t is string => t != null);

          const summary = [
            `## Session Summary`,
            `Phase: ${state.phase}`,
            `Completed: ${completedTasks.length} tasks`,
            `${completedTasks.map((t) => `- [x] ${t}`).join("\n")}`,
            pendingTasks.length > 0 ? `\nPending:\n${pendingTasks.map((t) => `- [ ] ${t}`).join("\n")}` : "",
            `\nTransitions: ${state.history.length}`,
          ].join("\n");

          const commitMsg = completedTasks.length > 0
            ? completedTasks.map((t) => t.replace(/^[^a-zA-Z]+/, "").substring(0, 72)).join("; ")
            : "chore: code-ensemble session";

          return JSON.stringify({ summary, commitMessage: commitMsg });
        },
      }),
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const state = await readCodeEnsembleState(directory, config.stateFile, stateDefaults);
      output.system.push(`## Current code-ensemble state\n${formatStateSummary(state)}`);
    },
    "experimental.session.compacting": async (_input, output) => {
      const state = await readCodeEnsembleState(directory, config.stateFile, stateDefaults);
      output.context.push(formatCompactionContext(state));
    },
    "experimental.provider.small_model": async (input, output) => {
      const fallbackByProvider: Record<string, string> = {};
      for (const [role, fallbacks] of Object.entries(config.fallbacks)) {
        if (fallbacks.length === 0) continue;
        const splitModel = config.roles[role as RoleName].model.split("/");
        const primaryProvider = splitModel[0];
        const fallback = fallbacks[0];
        if (primaryProvider && fallback && !fallbackByProvider[primaryProvider]) {
          fallbackByProvider[primaryProvider] = fallback;
        }
      }
      const fallbackModel = fallbackByProvider[input.provider.id];
      if (fallbackModel) {
        const [providerID, ...modelParts] = fallbackModel.split("/");
        output.model = {
          id: modelParts.join("/"),
          providerID,
        } as ModelV2;
      }
    },
  };
};
