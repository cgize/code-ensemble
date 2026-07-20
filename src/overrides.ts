import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getPackageRoot, loadDefaultConfig } from "./defaults.js";
import type {
  CodeEnsemblePluginOptions,
  CodeEnsembleProjectOverrides,
  FallbackRole,
  ResolvedCodeEnsembleConfig,
  RoleName,
} from "./types.js";

const ROLES: RoleName[] = [
  "director",
  "explorer",
  "visualizer",
  "planner",
  "architect",
  "implementer",
  "reviewer",
];
const ROLE_SET = new Set<string>(ROLES);
const FALLBACK_SET = new Set<string>(["planner", "architect"]);

class ConfigValidationError extends Error {
  constructor(path: string, got: unknown, want: string) {
    super(`code-ensemble.json: ${path}: expected ${want}, got ${typeOf(got)}`);
    this.name = "ConfigValidationError";
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fail(path: string, got: unknown, want: string): never {
  throw new ConfigValidationError(path, got, want);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isModelIdentifier(value: unknown): value is string {
  return isString(value) && /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(value);
}

function parseMap<T>(
  value: unknown,
  path: string,
  valid: Set<string>,
  parse: (item: unknown, itemPath: string) => T,
): Record<string, T> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) fail(path, value, "object");
  const result: Record<string, T> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!valid.has(key)) fail(`${path}.${key}`, key, "valid role");
    result[key] = parse(item, `${path}.${key}`);
  }
  return result;
}

export function parseOverrides(raw: unknown): CodeEnsembleProjectOverrides {
  if (!isObject(raw)) fail("(root)", raw, "object");
  const allowed = new Set(["models", "variants", "fallbacks"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(key, raw[key], "models, variants, or fallbacks");
  }

  const parseModel = (value: unknown, path: string) =>
    isModelIdentifier(value) ? value : fail(path, value, "model identifier in provider/model format");
  const parseVariant = (value: unknown, path: string) => isString(value) ? value : fail(path, value, "string");
  const models = parseMap(raw.models, "models", ROLE_SET, parseModel);
  const variants = parseMap(raw.variants, "variants", ROLE_SET, parseVariant);
  const fallbacks = parseMap(raw.fallbacks, "fallbacks", FALLBACK_SET, (value, path) => {
    if (!Array.isArray(value)) fail(path, value, "model identifier[]");
    return value.map((model, index) => parseModel(model, `${path}[${index}]`));
  });

  return {
    ...(models ? { models } : {}),
    ...(variants ? { variants } : {}),
    ...(fallbacks ? { fallbacks: fallbacks as Partial<Record<FallbackRole, string[]>> } : {}),
  };
}

export function resolveCodeEnsembleConfig(
  worktree: string,
  options: CodeEnsemblePluginOptions = {},
  metaUrl: string = import.meta.url,
): ResolvedCodeEnsembleConfig {
  const defaults = loadDefaultConfig(metaUrl);
  const packageRoot = getPackageRoot(metaUrl);
  const explicitPath = options.configPath ? resolve(worktree, options.configPath) : undefined;
  const discoveredPath = resolve(worktree, "code-ensemble.json");
  const overridePath = explicitPath ?? (existsSync(discoveredPath) ? discoveredPath : undefined);
  const overrides = overridePath && existsSync(overridePath)
    ? parseOverrides(JSON.parse(readFileSync(overridePath, "utf8")))
    : {};

  const roles = Object.fromEntries(ROLES.map((role) => {
    const roleDefaults = defaults.roles[role];
    return [role, {
      ...roleDefaults,
      model: overrides.models?.[role] ?? roleDefaults.model,
      variant: overrides.variants?.[role] ?? roleDefaults.variant,
      promptText: readFileSync(resolve(packageRoot, "defaults", roleDefaults.promptFile), "utf8"),
    }];
  })) as ResolvedCodeEnsembleConfig["roles"];

  roles.director.promptText = roles.director.promptText.replace(
    "{{routing}}",
    ROLES.filter((role) => role !== "director").map((role) => `- ${role}: \`${role}\``).join("\n"),
  );

  return {
    roles,
    fallbacks: {
      planner: overrides.fallbacks?.planner ?? defaults.roles.planner.fallbacks ?? [],
      architect: overrides.fallbacks?.architect ?? defaults.roles.architect.fallbacks ?? [],
    },
  };
}

export { ConfigValidationError };
