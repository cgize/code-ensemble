import { tool } from "@opencode-ai/plugin";
import { FallbackDelegator } from "./delegate.js";
import { fallbackAgentName } from "./fallback.js";
import { resolveCodeEnsembleConfig } from "./overrides.js";
import { addPlanTasks, approvePlan, closePlan, createPlan, readActivePlan, updatePlanTask } from "./plans.js";
function stringField(value, key) {
    if (!value || typeof value !== "object")
        return undefined;
    const field = value[key];
    return typeof field === "string" && field.length > 0 ? field : undefined;
}
function projectDirectory(input) {
    return (stringField(input, "worktree") ??
        stringField(input?.project, "worktree") ??
        stringField(input, "directory") ??
        stringField(input?.project, "directory") ??
        process.cwd());
}
function pluginOptions(options) {
    const configPath = stringField(options, "configPath");
    return configPath ? { configPath } : {};
}
function requireDirector(context) {
    if (stringField(context, "agent") !== "director")
        return "Only the director may use code-ensemble tools";
    if (!stringField(context, "sessionID"))
        return "A sessionID is required to use code-ensemble tools";
    return null;
}
const BASE_PERMISSION = {
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
const PROTECTED_READ = {
    "*": "allow",
    "*.env": "deny",
    "*.env.*": "deny",
    "*.env.example": "allow",
};
const PROTECTED_EDIT = {
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
};
const CODE_READ = {
    ...BASE_PERMISSION,
    read: PROTECTED_READ,
    glob: "allow",
    grep: "allow",
    list: "allow",
    lsp: "allow",
};
const SUBAGENT_PERMISSIONS = {
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
const SUBAGENT_ROLES = Object.keys(SUBAGENT_PERMISSIONS);
const FALLBACK_ROLES = ["planner", "architect"];
function agentDefinitions(config) {
    const taskPermissions = {
        "*": "deny",
        explorer: "allow",
        visualizer: "allow",
        implementer: "allow",
        reviewer: "allow",
    };
    const definitions = {
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
    for (const role of FALLBACK_ROLES) {
        config.fallbacks[role].forEach((model, index) => {
            definitions[fallbackAgentName(role, index + 1)] = {
                description: `Fallback model for ${role}.`,
                mode: "subagent",
                model,
                prompt: config.roles[role].promptText,
                permission: SUBAGENT_PERMISSIONS[role],
                hidden: true,
            };
        });
    }
    return definitions;
}
export const codeEnsemblePlugin = async (input, options = {}) => {
    const directory = projectDirectory(input);
    const config = resolveCodeEnsembleConfig(directory, pluginOptions(options));
    const delegator = input.client ? new FallbackDelegator(input.client) : undefined;
    return {
        config: async (runtimeConfig) => {
            runtimeConfig.agent ??= {};
            Object.assign(runtimeConfig.agent, agentDefinitions(config));
        },
        tool: {
            code_ensemble_delegate: tool({
                description: "Run planner or architect in the background with ordered model fallbacks.",
                args: {
                    role: tool.schema.enum(["planner", "architect"]),
                    description: tool.schema.string(),
                    prompt: tool.schema.string(),
                },
                async execute(args, context) {
                    const error = requireDirector(context);
                    if (error)
                        return JSON.stringify({ error });
                    if (!delegator)
                        return JSON.stringify({ error: "OpenCode did not provide a plugin client" });
                    try {
                        const result = delegator.start({
                            parentSessionID: context.sessionID,
                            description: args.description,
                            prompt: args.prompt,
                            role: args.role,
                            primaryAgent: args.role,
                            primaryModel: config.roles[args.role].model,
                            fallbackModels: config.fallbacks[args.role],
                            signal: context.abort,
                        });
                        return {
                            title: args.description,
                            metadata: { background: true, taskID: result.taskID },
                            output: result.output,
                        };
                    }
                    catch (caught) {
                        return JSON.stringify({ error: caught instanceof Error ? caught.message : String(caught) });
                    }
                },
            }),
            code_ensemble_plan: tool({
                description: "Create, read, approve, update, or close the project-wide .code-ensemble/TASKS.md plan.",
                args: {
                    action: tool.schema.enum(["create", "get", "approve", "add", "update", "close"]),
                    title: tool.schema.string().optional(),
                    tasks: tool.schema.array(tool.schema.string()).optional(),
                    expectedRevision: tool.schema.number().int().positive().optional(),
                    taskID: tool.schema.string().optional(),
                    status: tool.schema.enum(["pending", "in_progress", "completed", "blocked"]).optional(),
                    evidence: tool.schema.string().optional(),
                },
                async execute(args, context) {
                    const error = requireDirector(context);
                    if (error)
                        return JSON.stringify({ error });
                    try {
                        if (args.action === "get")
                            return JSON.stringify(await readActivePlan(directory));
                        if (args.action === "create") {
                            if (!args.title || !args.tasks)
                                return JSON.stringify({ error: "title and tasks are required for create" });
                            return JSON.stringify(await createPlan(directory, args.title, args.tasks, context.abort));
                        }
                        if (args.expectedRevision === undefined) {
                            return JSON.stringify({ error: "expectedRevision is required for approve, add, update, and close" });
                        }
                        if (args.action === "approve")
                            return JSON.stringify(await approvePlan(directory, args.expectedRevision, context.abort));
                        if (args.action === "close")
                            return JSON.stringify(await closePlan(directory, args.expectedRevision, context.abort));
                        if (args.action === "add") {
                            if (!args.tasks)
                                return JSON.stringify({ error: "tasks are required for add" });
                            return JSON.stringify(await addPlanTasks(directory, args.expectedRevision, args.tasks, context.abort));
                        }
                        if (!args.taskID || !args.status)
                            return JSON.stringify({ error: "taskID and status are required for update" });
                        return JSON.stringify(await updatePlanTask(directory, args.expectedRevision, args.taskID, args.status, args.evidence, context.abort));
                    }
                    catch (caught) {
                        return JSON.stringify({ error: caught instanceof Error ? caught.message : String(caught) });
                    }
                },
            }),
        },
        dispose: async () => {
            await delegator?.dispose();
        },
    };
};
//# sourceMappingURL=register.js.map