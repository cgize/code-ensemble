import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { getPackageRoot, loadDefaultConfig } from "./defaults.js";
import type {
  CodeEnsemblePluginOptions,
  CodeEnsembleProjectOverrides,
  ResolvedCodeEnsembleConfig,
  RoleName,
} from "./types.js";

type SubagentRoleName = Exclude<RoleName, "director">;

const ROLES = [
  "director",
  "explorer",
  "researcher",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
  "tester",
] as const;
const SUBAGENT_ROLES = ROLES.filter((r): r is SubagentRoleName => r !== "director");
const ROLE_SET = new Set<string>(ROLES);
const SUBAGENT_SET = new Set<string>(SUBAGENT_ROLES);

class ConfigValidationError extends Error {
  constructor(path: string, got: unknown, want: string) {
    super(`code-ensemble.json: ${path}: expected ${want}, got ${typeOf(got)}`);
    this.name = "ConfigValidationError";
  }
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function fail(path: string, got: unknown, want: string): never {
  throw new ConfigValidationError(path, got, want);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isModelIdentifier(v: unknown): v is string {
  return isString(v) && /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(v);
}

function isPosInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function mapKeys<T>(
  value: unknown,
  path: string,
  valid: Set<string>,
  parse: (v: unknown, key: string) => T,
): Record<string, T> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) fail(path, value, "object");
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!valid.has(k)) fail(`${path}.${k}`, k, "valid key");
    out[k] = parse(v, `${path}.${k}`);
  }
  return out;
}

function parseRoleNameArray(v: unknown, path: string): SubagentRoleName[] {
  if (!Array.isArray(v)) fail(path, v, "array");
  return v.map((item, i) => {
    const p = `${path}[${i}]`;
    if (!isString(item)) fail(p, item, "string");
    if (!SUBAGENT_SET.has(item)) fail(p, item, "subagent role");
    return item as SubagentRoleName;
  });
}

function parseOverrides(raw: unknown): CodeEnsembleProjectOverrides {
  if (!isObject(raw)) fail("(root)", raw, "object");
  const parseString = (v: unknown, p: string) => (isString(v) ? v : fail(p, v, "string"));
  const parseModel = (v: unknown, p: string) =>
    isModelIdentifier(v) ? v : fail(p, v, "model identifier in provider/model format");
  const parseStringArray = (v: unknown, p: string) => {
    if (!Array.isArray(v)) fail(p, v, "string[]");
    return v.map((item, i) => (isString(item) ? item : fail(`${p}[${i}]`, item, "string")));
  };

  const out: CodeEnsembleProjectOverrides = {};
  const m = mapKeys(raw.models, "models", ROLE_SET, parseModel);
  if (m) out.models = m;
  const v = mapKeys(raw.variants, "variants", ROLE_SET, parseString);
  if (v) out.variants = v;
  const f = mapKeys(raw.fallbacks, "fallbacks", ROLE_SET, (v, p) => {
    const fallbacks = parseStringArray(v, p);
    return fallbacks.map((model, index) =>
      isModelIdentifier(model) ? model : fail(`${p}[${index}]`, model, "model identifier in provider/model format"),
    );
  });
  if (f) out.fallbacks = f;
  const p = mapKeys(raw.prompts, "prompts", ROLE_SET, parseString);
  if (p) out.prompts = p;

  if (raw.subagents !== undefined) {
    if (!isObject(raw.subagents)) fail("subagents", raw.subagents, "object");
    const sub: CodeEnsembleProjectOverrides["subagents"] = {};
    if (raw.subagents.disable !== undefined) sub.disable = parseRoleNameArray(raw.subagents.disable, "subagents.disable");
    if (raw.subagents.rename !== undefined) {
      const r = mapKeys(raw.subagents.rename, "subagents.rename", SUBAGENT_SET, parseString);
      if (r) sub.rename = r as Partial<Record<SubagentRoleName, string>>;
    }
    if (Object.keys(sub).length > 0) out.subagents = sub;
  }

  if (raw.transitions !== undefined) {
    if (!isObject(raw.transitions)) fail("transitions", raw.transitions, "object");
    const t: NonNullable<CodeEnsembleProjectOverrides["transitions"]> = {};
    if (raw.transitions.reviewToPlanOnlyWithFindings !== undefined) {
      if (typeof raw.transitions.reviewToPlanOnlyWithFindings !== "boolean")
        fail("transitions.reviewToPlanOnlyWithFindings", raw.transitions.reviewToPlanOnlyWithFindings, "boolean");
      t.reviewToPlanOnlyWithFindings = raw.transitions.reviewToPlanOnlyWithFindings;
    }
    if (raw.transitions.autoLoop !== undefined) {
      if (typeof raw.transitions.autoLoop !== "boolean")
        fail("transitions.autoLoop", raw.transitions.autoLoop, "boolean");
      t.autoLoop = raw.transitions.autoLoop;
    }
    if (raw.transitions.autoLoopMaxIterations !== undefined) {
      if (!isPosInt(raw.transitions.autoLoopMaxIterations))
        fail("transitions.autoLoopMaxIterations", raw.transitions.autoLoopMaxIterations, "positive integer");
      t.autoLoopMaxIterations = raw.transitions.autoLoopMaxIterations;
    }
    if (Object.keys(t).length > 0) out.transitions = t;
  }

  return out;
}

function loadTextFile(baseDir: string, relativePath: string): string {
  return readFileSync(isAbsolute(relativePath) ? relativePath : resolve(baseDir, relativePath), "utf8");
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
      ? parseOverrides(JSON.parse(readFileSync(overridePath, "utf8")))
      : {};

  const roles = Object.fromEntries(
    ROLES.map((role) => {
      const r = defaults.roles[role];
      const promptPath = overrides.prompts?.[role]
        ? resolve(worktree, overrides.prompts[role])
        : resolve(packageRoot, "defaults", r.promptFile);
      return [
        role,
        {
          ...r,
          model: overrides.models?.[role] ?? r.model,
          variant: overrides.variants?.[role] ?? r.variant,
          promptText: loadTextFile(worktree, promptPath),
        },
      ];
    }),
  ) as ResolvedCodeEnsembleConfig["roles"];

  const commandTemplates = Object.fromEntries(
    Object.entries(defaults.commands).map(([command, p]) => [
      command,
      loadTextFile(resolve(packageRoot, "defaults"), p),
    ]),
  ) as ResolvedCodeEnsembleConfig["commandTemplates"];

  return {
    stateFile: defaults.stateFile,
    roles,
    promptText: Object.fromEntries(ROLES.map((role) => [role, roles[role].promptText])) as ResolvedCodeEnsembleConfig["promptText"],
    fallbacks: Object.fromEntries(
      ROLES.map((role) => [role, overrides.fallbacks?.[role] ?? defaults.roles[role].fallbacks ?? []]),
    ) as ResolvedCodeEnsembleConfig["fallbacks"],
    commandTemplates,
    disabledSubagents: overrides.subagents?.disable ?? [],
    renamedSubagents: overrides.subagents?.rename ?? {},
    transitions: {
      reviewToPlanOnlyWithFindings:
        overrides.transitions?.reviewToPlanOnlyWithFindings ?? defaults.transitions.reviewToPlanOnlyWithFindings,
      autoLoop: overrides.transitions?.autoLoop ?? defaults.transitions.autoLoop,
      autoLoopMaxIterations:
        overrides.transitions?.autoLoopMaxIterations ?? defaults.transitions.autoLoopMaxIterations,
    },
  };
}

export { ConfigValidationError, parseOverrides };
