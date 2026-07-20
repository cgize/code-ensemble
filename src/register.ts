import { tool, type Plugin } from "@opencode-ai/plugin";

import { resolveCodeEnsembleConfig } from "./overrides.js";
import { addPlanTasks, approvePlan, closePlan, createPlan, readActivePlan, updatePlanTask } from "./plans.js";
import {
  formatClosedPlanOutput,
  formatPlanOutput,
  formatToolError,
  planToolTitle,
} from "./present.js";
import type { CodeEnsemblePluginOptions, ResolvedCodeEnsembleConfig, RoleName } from "./types.js";

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function projectDirectory(input: unknown): string {
  return (
    stringField(input, "worktree") ??
    stringField((input as { project?: unknown } | undefined)?.project, "worktree") ??
    stringField(input, "directory") ??
    stringField((input as { project?: unknown } | undefined)?.project, "directory") ??
    process.cwd()
  );
}

function pluginOptions(options: unknown): CodeEnsemblePluginOptions {
  const configPath = stringField(options, "configPath");
  return configPath ? { configPath } : {};
}

function requireDirector(context: unknown): string | null {
  if (stringField(context, "agent") !== "director") return "Only the director may use code-ensemble tools";
  if (!stringField(context, "sessionID")) return "A sessionID is required to use code-ensemble tools";
  return null;
}

type PermissionAction = "allow" | "ask" | "deny";
type PermissionRule = PermissionAction | Record<string, PermissionAction>;
type AgentPermission = Record<string, PermissionRule>;
type SubagentRole = Exclude<RoleName, "director">;

const BASE_PERMISSION: AgentPermission = {
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
  plan: "deny",
};

const PROTECTED_READ: Record<string, PermissionAction> = {
  "*": "allow",
  "*.env": "deny",
  "*.env.*": "deny",
  "*.env.example": "allow",
};

const PROTECTED_EDIT: Record<string, PermissionAction> = {
  "*": "allow",
  "*.env": "ask",
  "*.env.*": "ask",
  "*.env.example": "allow",
};

const CODE_READ: AgentPermission = {
  ...BASE_PERMISSION,
  read: PROTECTED_READ,
  glob: "allow",
  grep: "allow",
  list: "allow",
  lsp: "allow",
};

const SUBAGENT_PERMISSIONS: Record<SubagentRole, AgentPermission> = {
  explorer: { ...CODE_READ },
  visualizer: { ...BASE_PERMISSION, read: PROTECTED_READ, skill: "allow" },
  planner: { ...CODE_READ, webfetch: "allow", websearch: "allow", skill: "allow" },
  architect: { ...CODE_READ, webfetch: "allow", websearch: "allow", skill: "allow" },
  implementer: {
    ...CODE_READ,
    edit: PROTECTED_EDIT,
    bash: {
      "*": "ask",
      "rm": "deny",
      "rm *": "deny",
      "rmdir": "deny",
      "rmdir *": "deny",
      "del": "deny",
      "del *": "deny",
      "Remove-Item*": "deny",
      "npm publish*": "deny",
      "pnpm publish*": "deny",
      "yarn publish*": "deny",
      "bun publish*": "deny",
    },
    skill: "allow",
  },
  reviewer: {
    ...CODE_READ,
    bash: { "*": "ask" },
    webfetch: "allow",
    websearch: "allow",
    skill: "allow",
  },
};

const SUBAGENT_ROLES = Object.keys(SUBAGENT_PERMISSIONS) as SubagentRole[];

function agentDefinitions(config: ResolvedCodeEnsembleConfig): Record<string, unknown> {
  const taskPermissions: Record<string, "allow" | "deny"> = {
    "*": "deny",
    explorer: "allow",
    visualizer: "allow",
    planner: "allow",
    architect: "allow",
    implementer: "allow",
    reviewer: "allow",
  };
  const definitions: Record<string, unknown> = {
    director: {
      description: "Coordinates planning, implementation, and review.",
      mode: "primary",
      model: config.roles.director.model,
      ...(config.roles.director.variant ? { variant: config.roles.director.variant } : {}),
      prompt: config.roles.director.promptText,
      permission: { edit: "deny", bash: "deny", task: taskPermissions },
    },
  };

  for (const role of SUBAGENT_ROLES) {
    const roleConfig = config.roles[role];
    definitions[role] = {
      description: `${role} specialist for code-ensemble.`,
      mode: "subagent",
      model: roleConfig.model,
      ...(roleConfig.variant ? { variant: roleConfig.variant } : {}),
      prompt: roleConfig.promptText,
      permission: SUBAGENT_PERMISSIONS[role],
    };
  }

  return definitions;
}

export const codeEnsemblePlugin: Plugin = async (input, options = {}) => {
  const directory = projectDirectory(input);
  const config = resolveCodeEnsembleConfig(directory, pluginOptions(options));

  return {
    config: async (runtimeConfig) => {
      runtimeConfig.agent ??= {};
      Object.assign(runtimeConfig.agent, agentDefinitions(config));
    },
    tool: {
      plan: tool({
        description: "Read or update the shared project plan in .code-ensemble/TASKS.md.",
        args: {
          action: tool.schema
            .enum(["create", "get", "approve", "add", "update", "close"])
            .describe("Plan action to perform"),
          title: tool.schema.string().optional().describe("Plan title when creating"),
          tasks: tool.schema.array(tool.schema.string()).optional().describe("Task texts for create or add"),
          expectedRevision: tool.schema.number().int().positive().optional().describe("Current plan revision"),
          taskID: tool.schema.string().optional().describe("Task id for update, e.g. T001"),
          status: tool.schema
            .enum(["pending", "in_progress", "completed", "blocked"])
            .optional()
            .describe("New task status for update"),
          evidence: tool.schema.string().optional().describe("Verification evidence when completing a task"),
        },
        async execute(args, context) {
          const title = planToolTitle(args);
          context.metadata({ title });
          const error = requireDirector(context);
          if (error) return formatToolError(error);
          const ok = (output: string) => ({ title, output });
          try {
            if (args.action === "get") {
              const active = await readActivePlan(directory);
              return ok(formatPlanOutput(active?.plan ?? null));
            }
            if (args.action === "create") {
              if (!args.title || !args.tasks) return formatToolError("title and tasks are required for create");
              return ok(formatPlanOutput(await createPlan(directory, args.title, args.tasks, context.abort)));
            }
            if (args.expectedRevision === undefined) {
              return formatToolError("expectedRevision is required for approve, add, update, and close");
            }
            if (args.action === "approve") {
              return ok(formatPlanOutput(await approvePlan(directory, args.expectedRevision, context.abort)));
            }
            if (args.action === "close") {
              const closed = await closePlan(directory, args.expectedRevision, context.abort);
              return ok(formatClosedPlanOutput(closed.plan, closed.archived));
            }
            if (args.action === "add") {
              if (!args.tasks) return formatToolError("tasks are required for add");
              return ok(formatPlanOutput(await addPlanTasks(directory, args.expectedRevision, args.tasks, context.abort)));
            }
            if (!args.taskID || !args.status) return formatToolError("taskID and status are required for update");
            return ok(formatPlanOutput(await updatePlanTask(
              directory,
              args.expectedRevision,
              args.taskID,
              args.status,
              args.evidence,
              context.abort,
            )));
          } catch (caught) {
            return formatToolError(caught instanceof Error ? caught.message : String(caught));
          }
        },
      }),
    },
  };
};
