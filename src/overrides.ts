import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { getPackageRoot, loadDefaultConfig } from "./defaults.js";
import type {
  CodeEnsemblePluginOptions,
  CodeEnsembleProjectOverrides,
  ResolvedCodeEnsembleConfig,
  RoleName,
} from "./types.js";

type SubagentRoleName = Exclude<RoleName, "director">;

const roleNames = [
  "director",
  "explorer",
  "researcher",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
  "tester",
] as const satisfies readonly RoleName[];

const subagentRoleNames = [
  "explorer",
  "researcher",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
  "tester",
] as const satisfies readonly SubagentRoleName[];

const overrideSchema: z.ZodType<CodeEnsembleProjectOverrides> = z.object({
  models: z.record(z.enum(roleNames), z.string()).optional(),
  variants: z.record(z.enum(roleNames), z.string()).optional(),
  fallbacks: z.record(z.enum(roleNames), z.array(z.string())).optional(),
  prompts: z.record(z.enum(roleNames), z.string()).optional(),
  subagents: z
    .object({
      disable: z.array(z.enum(subagentRoleNames)).optional(),
      rename: z.record(z.enum(subagentRoleNames), z.string()).optional(),
    })
    .optional(),
  transitions: z
    .object({
      reviewToPlanOnlyWithFindings: z.boolean().optional(),
      autoLoop: z.boolean().optional(),
      autoLoopMaxIterations: z.number().int().positive().optional(),
    })
    .optional(),
});

function loadTextFile(baseDir: string, relativePath: string): string {
  const fullPath = isAbsolute(relativePath) ? relativePath : resolve(baseDir, relativePath);
  return readFileSync(fullPath, "utf8");
}

export function resolveCodeEnsembleConfig(
  worktree: string,
  options: CodeEnsemblePluginOptions = {},
  metaUrl: string = import.meta.url,
): ResolvedCodeEnsembleConfig {
  const defaults = loadDefaultConfig(metaUrl);
  const packageRoot = getPackageRoot(metaUrl);
  const explicitPath = options.configPath ? resolve(worktree, options.configPath) : null;
  const autoDiscoveryPath = resolve(worktree, "code-ensemble.json");
  const overridePath = explicitPath ?? (existsSync(autoDiscoveryPath) ? autoDiscoveryPath : null);
  const overrides =
    overridePath && existsSync(overridePath)
      ? overrideSchema.parse(JSON.parse(readFileSync(overridePath, "utf8")))
      : {};

  const roles = Object.fromEntries(
    roleNames.map((role) => {
      const roleDefaults = defaults.roles[role];
      const promptPath = overrides.prompts?.[role]
        ? resolve(worktree, overrides.prompts[role])
        : resolve(packageRoot, "defaults", roleDefaults.promptFile);

      return [
        role,
        {
          ...roleDefaults,
          model: overrides.models?.[role] ?? roleDefaults.model,
          variant: overrides.variants?.[role] ?? roleDefaults.variant,
          promptText: loadTextFile(worktree, promptPath),
        },
      ];
    }),
  ) as ResolvedCodeEnsembleConfig["roles"];

  const commandTemplates = Object.fromEntries(
    Object.entries(defaults.commands).map(([command, relativePath]) => [
      command,
      loadTextFile(resolve(packageRoot, "defaults"), relativePath),
    ]),
  ) as ResolvedCodeEnsembleConfig["commandTemplates"];

  return {
    stateFile: defaults.stateFile,
    roles,
    promptText: Object.fromEntries(roleNames.map((role) => [role, roles[role].promptText])) as ResolvedCodeEnsembleConfig["promptText"],
    fallbacks: Object.fromEntries(
      roleNames.map((role) => [
        role,
        overrides.fallbacks?.[role] ?? defaults.roles[role].fallbacks ?? [],
      ]),
    ) as ResolvedCodeEnsembleConfig["fallbacks"],
    commandTemplates,
    disabledSubagents: overrides.subagents?.disable ?? [],
    renamedSubagents: overrides.subagents?.rename ?? {},
    transitions: {
      reviewToPlanOnlyWithFindings:
        overrides.transitions?.reviewToPlanOnlyWithFindings ??
        defaults.transitions.reviewToPlanOnlyWithFindings,
      autoLoop: overrides.transitions?.autoLoop ?? defaults.transitions.autoLoop,
      autoLoopMaxIterations:
        overrides.transitions?.autoLoopMaxIterations ?? defaults.transitions.autoLoopMaxIterations,
    },
  };
}
