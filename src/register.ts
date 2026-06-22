import { tool, type Plugin } from "@opencode-ai/plugin";

import { buildCommandDefinitions } from "./commands.js";
import { resolveCodeSwarmConfig } from "./overrides.js";
import {
  approveCodeSwarmTransition,
  forceCodeSwarmPhase,
  proposeCodeSwarmTransition,
  readCodeSwarmState,
  resetCodeSwarmState,
} from "./state.js";
import type { CodeSwarmPluginOptions, CodeSwarmState, Phase, ResolvedCodeSwarmConfig, RoleName } from "./types.js";

export function formatStateSummary(state: CodeSwarmState): string {
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
    `Last plan summary: ${state.lastPlanSummary || "none"}`,
    `Last review findings:\n${findings}`,
    `Open issues:\n${issues}`,
  ].join("\n");
}

export function formatCompactionContext(state: CodeSwarmState): string {
  const recentHistory =
    state.history
      .slice(-3)
      .map((entry) => `- ${entry.from} -> ${entry.to} @ ${entry.at}: ${entry.summary}`)
      .join("\n") || "- none";

  return [
    "## Code Swarm Runtime State",
    formatStateSummary(state),
    "Recent transitions:",
    recentHistory,
  ].join("\n");
}

type SwarmSubagent = Exclude<RoleName, "orchestrator">;

function buildAgentDefinitions(config: ResolvedCodeSwarmConfig) {
  const getAgentName = (role: SwarmSubagent) => config.renamedSubagents[role] ?? role;

  const isDisabled = (role: SwarmSubagent) => config.disabledSubagents.includes(role);

  const agentDefinitions: Record<string, unknown> = {
    orchestrator: {
      description: "Coordinates the code-swarm workflow across plan, implement, and review.",
      mode: config.roles.orchestrator.mode,
      model: config.roles.orchestrator.model,
      variant: config.roles.orchestrator.variant,
      prompt: config.roles.orchestrator.promptText,
      permission: {
        edit: "deny",
        bash: "deny",
        task: {
          "*": "deny",
          [getAgentName("explorer")]: isDisabled("explorer") ? "deny" : "allow",
          [getAgentName("planner")]: isDisabled("planner") ? "deny" : "allow",
          [getAgentName("implementer")]: isDisabled("implementer") ? "deny" : "allow",
          [getAgentName("reviewer")]: isDisabled("reviewer") ? "deny" : "allow",
          [getAgentName("tester")]: isDisabled("tester") ? "deny" : "allow",
          [getAgentName("researcher")]: isDisabled("researcher") ? "deny" : "allow",
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

  if (!isDisabled("planner")) {
    agentDefinitions[getAgentName("planner")] = {
      description: "Planning specialist for the plan phase.",
      mode: config.roles.planner.mode,
      model: config.roles.planner.model,
      variant: config.roles.planner.variant,
      prompt: config.roles.planner.promptText,
      permission: { edit: "deny", bash: "deny" },
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

export const codeSwarmPlugin: Plugin = async ({ worktree }, options = {}) => {
  const config = resolveCodeSwarmConfig(worktree, options as CodeSwarmPluginOptions);

  return {
    config: async (cfg) => {
      cfg.agent ??= {};
      cfg.command ??= {};
      Object.assign(cfg.agent, buildAgentDefinitions(config));
      Object.assign(cfg.command, buildCommandDefinitions(config));
    },
    tool: {
      code_swarm_state: tool({
        description: "Read or reset the code-swarm state for the current project.",
        args: {
          action: tool.schema.enum(["get", "reset"]),
        },
        async execute(args) {
          if (args.action === "reset") {
            const state = await resetCodeSwarmState(worktree, config.stateFile);
            return JSON.stringify(state);
          }

          const state = await readCodeSwarmState(worktree, config.stateFile);
          return JSON.stringify(state);
        },
      }),
      code_swarm_transition: tool({
        description: "Propose, approve, or force a code-swarm phase transition.",
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
            const state = await proposeCodeSwarmTransition(worktree, config.stateFile, args.phase);
            return JSON.stringify(state);
          }

          if (args.action === "approve") {
            const state = await approveCodeSwarmTransition(worktree, config.stateFile, {
              planSummary: args.planSummary,
              reviewFindings: args.reviewFindings,
              openIssues: args.openIssues,
            });
            return JSON.stringify(state);
          }

          if (!args.phase) {
            return JSON.stringify({ error: "phase is required for force action" });
          }
          const state = await forceCodeSwarmPhase(
            worktree,
            config.stateFile,
            args.phase,
            args.summary ?? `Forced by user to ${args.phase}`,
          );
          return JSON.stringify(state);
        },
      }),
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const state = await readCodeSwarmState(worktree, config.stateFile);
      output.system.push(`## Current code-swarm state\n${formatStateSummary(state)}`);
    },
    "experimental.session.compacting": async (_input, output) => {
      const state = await readCodeSwarmState(worktree, config.stateFile);
      output.context.push(formatCompactionContext(state));
    },
  };
};
