import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { tool, type Plugin } from "@opencode-ai/plugin";

import { buildCommandDefinitions } from "./commands.js";
import { delegateWithFallback, fallbackAgentName, type FallbackRole } from "./fallback.js";
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

function getStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function resolveProjectDirectory(input: unknown): string {
  return (
    getStringField(input, "directory") ??
    getStringField(input, "worktree") ??
    getStringField((input as { project?: unknown } | undefined)?.project, "directory") ??
    getStringField((input as { project?: unknown } | undefined)?.project, "worktree") ??
    process.cwd()
  );
}

function resolveToolDirectory(ctx: unknown, fallback: string): string {
  return getStringField(ctx, "directory") ?? getStringField(ctx, "worktree") ?? fallback;
}

function normalizePluginOptions(options: unknown): CodeEnsemblePluginOptions {
  const configPath = getStringField(options, "configPath");
  return configPath ? { configPath } : {};
}

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
type PermissionAction = "allow" | "ask" | "deny";
type PermissionRule = PermissionAction | Record<string, PermissionAction>;
type SubagentPermission = Record<string, PermissionRule>;
type SubagentSpec = {
  description: string;
  permission: SubagentPermission;
};

const PROTECTED_READ_PERMISSION: Record<string, PermissionAction> = {
  "*": "allow",
  "*.env": "deny",
  "*.env.*": "deny",
  "*.env.example": "allow",
};

const PROTECTED_EDIT_PERMISSION: Record<string, PermissionAction> = {
  "*": "allow",
  "*.env": "ask",
  "*.env.*": "ask",
  "*.env.example": "allow",
};

const BASE_SUBAGENT_PERMISSION: SubagentPermission = {
  "*": "deny",
  read: "deny",
  edit: "deny",
  glob: "deny",
  grep: "deny",
  list: "deny",
  bash: "deny",
  task: "deny",
  external_directory: "deny",
  todowrite: "deny",
  question: "deny",
  webfetch: "deny",
  websearch: "deny",
  lsp: "deny",
  doom_loop: "ask",
  skill: "deny",
  "code_ensemble_*": "deny",
};

const CODE_READ_PERMISSION: SubagentPermission = {
  ...BASE_SUBAGENT_PERMISSION,
  read: PROTECTED_READ_PERMISSION,
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
};

const READ_ONLY_GIT_COMMANDS: Record<string, PermissionAction> = {
  "git status*": "allow",
  "git diff*": "allow",
  "git log*": "allow",
  "git show*": "allow",
  "git blame*": "allow",
  "git rev-parse*": "allow",
  "git ls-files*": "allow",
  "git grep*": "allow",
  "git remote -v*": "allow",
};

const READ_ONLY_GIT_PERMISSION: Record<string, PermissionAction> = {
  "*": "deny",
  ...READ_ONLY_GIT_COMMANDS,
};

const IMPLEMENTATION_BASH_PERMISSION: Record<string, PermissionAction> = {
  "*": "allow",
  "git *": "deny",
  ...READ_ONLY_GIT_COMMANDS,
  rm: "deny",
  "rm *": "deny",
  rmdir: "deny",
  "rmdir *": "deny",
  del: "deny",
  "del *": "deny",
  "Remove-Item*": "deny",
  "npm publish*": "deny",
  "pnpm publish*": "deny",
  "yarn publish*": "deny",
  "bun publish*": "deny",
};

const TEST_BASH_PERMISSION: Record<string, PermissionAction> = {
  ...IMPLEMENTATION_BASH_PERMISSION,
  "npm install*": "deny",
  "npm uninstall*": "deny",
  "npm update*": "deny",
  "npm ci*": "deny",
  "npm i": "deny",
  "npm i *": "deny",
  "pnpm install*": "deny",
  "pnpm add*": "deny",
  "pnpm remove*": "deny",
  "pnpm update*": "deny",
  "yarn install*": "deny",
  "yarn add*": "deny",
  "yarn remove*": "deny",
  "yarn upgrade*": "deny",
  "bun install*": "deny",
  "bun add*": "deny",
  "bun remove*": "deny",
  "bun update*": "deny",
  "pip install*": "deny",
  "pip3 install*": "deny",
  "uv add*": "deny",
  "uv remove*": "deny",
  "uv sync*": "deny",
  "poetry add*": "deny",
  "poetry remove*": "deny",
  "poetry install*": "deny",
  "poetry update*": "deny",
  "cargo add*": "deny",
  "cargo remove*": "deny",
  "cargo install*": "deny",
  "cargo update*": "deny",
};

const SUBAGENT_SPECS: Record<EnsembleSubagent, SubagentSpec> = {
  explorer: {
    description: "Fast read-only codebase explorer.",
    permission: { ...CODE_READ_PERMISSION },
  },
  researcher: {
    description: "External docs and dependency researcher.",
    permission: {
      ...BASE_SUBAGENT_PERMISSION,
      read: PROTECTED_READ_PERMISSION,
      glob: "allow",
      grep: "allow",
      list: "allow",
      webfetch: "allow",
      websearch: "allow",
      skill: "allow",
    },
  },
  visualizer: {
    description: "Vision specialist for screenshots, diagrams, and image attachments.",
    permission: {
      ...BASE_SUBAGENT_PERMISSION,
      read: PROTECTED_READ_PERMISSION,
      skill: "allow",
    },
  },
  planner: {
    description: "Planning specialist for the plan phase.",
    permission: { ...CODE_READ_PERMISSION, skill: "allow" },
  },
  architect: {
    description: "Critical decision specialist for architecture and high-risk changes.",
    permission: {
      ...CODE_READ_PERMISSION,
      webfetch: "allow",
      websearch: "allow",
      skill: "allow",
    },
  },
  implementer: {
    description: "Implementation specialist for the implement phase.",
    permission: {
      ...CODE_READ_PERMISSION,
      edit: PROTECTED_EDIT_PERMISSION,
      bash: IMPLEMENTATION_BASH_PERMISSION,
      skill: "allow",
    },
  },
  reviewer: {
    description: "Read-only review specialist for the review phase.",
    permission: {
      ...CODE_READ_PERMISSION,
      bash: READ_ONLY_GIT_PERMISSION,
      webfetch: "allow",
      websearch: "allow",
      skill: "allow",
    },
  },
  tester: {
    description: "Verification specialist for targeted checks.",
    permission: {
      ...CODE_READ_PERMISSION,
      bash: TEST_BASH_PERMISSION,
      skill: "allow",
    },
  },
};

const SUBAGENT_ROLES = Object.keys(SUBAGENT_SPECS) as EnsembleSubagent[];
const FALLBACK_ROLES: FallbackRole[] = ["planner", "architect"];

function buildAgentDefinitions(config: ResolvedCodeEnsembleConfig) {
  const getAgentName = (role: EnsembleSubagent) => config.renamedSubagents[role] ?? role;
  const isDisabled = (role: EnsembleSubagent) => config.disabledSubagents.includes(role);

  const directorRole = config.roles.director;
  const taskPermissions: Record<string, "allow" | "deny"> = { "*": "deny" };
  for (const sub of SUBAGENT_ROLES) {
    taskPermissions[getAgentName(sub)] = isDisabled(sub) || FALLBACK_ROLES.includes(sub as FallbackRole) ? "deny" : "allow";
  }

  const agentDefinitions: Record<string, unknown> = {
    director: {
      description: "Coordinates the code-ensemble workflow across plan, implement, and review.",
      mode: directorRole.mode,
      model: directorRole.model,
      ...(directorRole.variant ? { variant: directorRole.variant } : {}),
      prompt: directorRole.promptText,
      permission: { edit: "deny", bash: "deny", task: taskPermissions },
    },
  };

  for (const role of SUBAGENT_ROLES) {
    if (isDisabled(role)) continue;
    const spec = SUBAGENT_SPECS[role];
    const roleCfg = config.roles[role];
    const definition: Record<string, unknown> = {
      description: spec.description,
      mode: roleCfg.mode,
      model: roleCfg.model,
      ...(roleCfg.variant ? { variant: roleCfg.variant } : {}),
      prompt: roleCfg.promptText,
      permission: spec.permission,
    };
    agentDefinitions[getAgentName(role)] = definition;
  }

  for (const role of FALLBACK_ROLES) {
    const fallback = config.fallbacks[role][0];
    if (!fallback || isDisabled(role)) continue;
    const spec = SUBAGENT_SPECS[role];
    const roleCfg = config.roles[role];
    agentDefinitions[fallbackAgentName(role)] = {
      description: `Quota fallback for ${getAgentName(role)}.`,
      mode: "subagent",
      model: fallback,
      prompt: roleCfg.promptText,
      permission: spec.permission,
      hidden: true,
    };
  }

  return agentDefinitions;
}

export const codeEnsemblePlugin: Plugin = async (input, options = {}) => {
  const projectDirectory = resolveProjectDirectory(input);
  const config = resolveCodeEnsembleConfig(projectDirectory, normalizePluginOptions(options));

  const stateDefaults = {
    autoLoop: config.transitions.autoLoop,
    autoLoopMaxIterations: config.transitions.autoLoopMaxIterations,
    reviewToPlanOnlyWithFindings: config.transitions.reviewToPlanOnlyWithFindings,
  };
  const getAgentName = (role: EnsembleSubagent) => config.renamedSubagents[role] ?? role;

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
            const state = await resetCodeEnsembleState(projectDirectory, config.stateFile, stateDefaults);
            return JSON.stringify(state);
          }

          const state = await readCodeEnsembleState(projectDirectory, config.stateFile, stateDefaults);
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
              projectDirectory,
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
              projectDirectory,
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
            projectDirectory,
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
            projectDirectory,
            config.stateFile,
            { enabled: args.enabled },
            stateDefaults,
          );
          return JSON.stringify(state);
        },
      }),
      code_ensemble_delegate: tool({
        description:
          "Delegate a planner or architect task with a single model fallback. Use this instead of task for planner and architect.",
        args: {
          role: tool.schema.enum(["planner", "architect"]),
          description: tool.schema.string(),
          prompt: tool.schema.string(),
        },
        async execute(args, ctx) {
          if (ctx.agent !== "director") {
            return JSON.stringify({ error: "code_ensemble_delegate may only be used by the director" });
          }
          try {
            const result = await delegateWithFallback(input.client, {
              parentSessionID: ctx.sessionID,
              description: args.description,
              prompt: args.prompt,
              role: args.role,
              primaryAgent: getAgentName(args.role),
              primaryModel: config.roles[args.role].model,
              fallbackModel: config.fallbacks[args.role][0],
            });
            return {
              title: args.description,
              metadata: { model: result.model, usedFallback: result.usedFallback, sessionID: result.sessionID },
              output: [
                `<task id="${result.sessionID}" state="completed">`,
                "<task_result>",
                result.output,
                "</task_result>",
                "</task>",
              ].join("\n"),
            };
          } catch (error) {
            return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
          }
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
          const directory = resolveToolDirectory(ctx, projectDirectory);
          const dir = args.phase
            ? resolve(directory, ".code-ensemble", "artifacts", args.phase)
            : resolve(directory, ".code-ensemble", "artifacts");
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
          const directory = resolveToolDirectory(ctx, projectDirectory);
          const state = await readCodeEnsembleState(directory, config.stateFile, stateDefaults);
          const artifactsDir = resolve(directory, ".code-ensemble", "artifacts");
          const artifactContents: { path: string; content: string }[] = [];

          function walk(dir: string) {
            if (!existsSync(dir)) return;
            for (const entry of readdirSync(dir)) {
              const full = resolve(dir, entry);
              if (statSync(full).isDirectory()) {
                walk(full);
              } else if (entry.endsWith(".md")) {
                artifactContents.push({
                  path: relative(directory, full),
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
      const state = await readCodeEnsembleState(projectDirectory, config.stateFile, stateDefaults);
      output.system.push(`## Current code-ensemble state\n${formatStateSummary(state)}`);
    },
    "experimental.session.compacting": async (_input, output) => {
      const state = await readCodeEnsembleState(projectDirectory, config.stateFile, stateDefaults);
      output.context.push(formatCompactionContext(state));
    },
  };
};
