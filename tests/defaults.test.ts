import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadDefaultConfig } from "../src/index.js";
import { resolveCodeEnsembleConfig } from "../src/overrides";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadDefaultConfig", () => {
  it("returns the default role matrix from the packaged JSON file", () => {
    const config = loadDefaultConfig();

    expect(config.stateFile).toBe(".opencode/state/code-ensemble.json");
    expect(config.roles.planner).toMatchObject({
      model: "openai/gpt-5.4",
      variant: "xhigh",
    });
    expect(config.roles.planner.fallbacks).toEqual(["opencode-go/glm-5.2"]);
    expect(config.roles.architect).toMatchObject({
      model: "openai/gpt-5.5",
      variant: "xhigh",
    });
    expect(config.roles.architect.fallbacks).toEqual(["opencode-go/deepseek-v4-pro"]);
    expect(config.roles.visualizer).toMatchObject({
      model: "opencode-go/mimo-v2.5",
      variant: "max",
    });
    expect(config.roles.implementer).toMatchObject({
      model: "opencode-go/deepseek-v4-pro",
      variant: "max",
    });
    expect(config.commands["force-phase"]).toBe("commands/force-phase.md");
  });

  it("uses explicit .js specifiers in barrel exports for published ESM output", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const indexPath = resolve(testDir, "../src/index.ts");
    const indexSource = readFileSync(indexPath, "utf8");

    expect(indexSource).toContain('from "./defaults.js"');
    expect(indexSource).toContain('from "./types.js"');
  });

  it("uses strict TypeScript compiler options", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const tsconfigPath = resolve(testDir, "../tsconfig.json");
    const tsconfigSource = readFileSync(tsconfigPath, "utf8");

    expect(tsconfigSource).toContain('"strict": true');
    expect(tsconfigSource).toContain('"module": "ESNext"');
  });
});

describe("resolveCodeEnsembleConfig", () => {
  it("merges project overrides and loads prompt text", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-ensemble-"));
    tempDirs.push(root);

    await mkdir(resolve(root, ".code-ensemble"), { recursive: true });
    await writeFile(
      resolve(root, "code-ensemble.json"),
      JSON.stringify(
        {
          models: { planner: "openai/gpt-5.4-mini" },
          variants: { planner: "high" },
          prompts: { director: "./.code-ensemble/director.md" },
          subagents: { disable: ["researcher"], rename: { tester: "verifier" } },
        },
        null,
        2,
      ),
    );
    await writeFile(resolve(root, ".code-ensemble", "director.md"), "Custom director prompt");

    const resolved = resolveCodeEnsembleConfig(root, { configPath: "./code-ensemble.json" });

    expect(resolved.roles.planner.model).toBe("openai/gpt-5.4-mini");
    expect(resolved.roles.planner.variant).toBe("high");
    expect(resolved.promptText.director).toContain("Custom director prompt");
    expect(resolved.disabledSubagents).toEqual(["researcher"]);
    expect(resolved.renamedSubagents.tester).toBe("verifier");
  });

  it("auto-discovers code-ensemble.json in the worktree root when configPath is omitted", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-ensemble-auto-"));
    tempDirs.push(root);

    await writeFile(
      resolve(root, "code-ensemble.json"),
      JSON.stringify({ models: { reviewer: "opencode-go/glm-5.1" } }, null, 2),
    );

    const resolved = resolveCodeEnsembleConfig(root);

    expect(resolved.roles.reviewer.model).toBe("opencode-go/glm-5.1");
  });

  it("resolves fallbacks from defaults and allows overriding", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-ensemble-fb-"));
    tempDirs.push(root);

    await writeFile(
      resolve(root, "code-ensemble.json"),
      JSON.stringify(
        {
          fallbacks: { planner: ["openai/gpt-5.4-mini", "opencode-go/deepseek-v4-flash"] },
        },
        null,
        2,
      ),
    );

    const resolved = resolveCodeEnsembleConfig(root);

    expect(resolved.fallbacks.planner).toEqual(["openai/gpt-5.4-mini", "opencode-go/deepseek-v4-flash"]);
    expect(resolved.fallbacks.director).toEqual([]);
    expect(resolved.fallbacks.visualizer).toEqual([]);
    expect(resolved.fallbacks.implementer).toEqual([]);
  });

  it("exports ResolvedRoleConfig from the package barrel", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const indexPath = resolve(testDir, "../src/index.ts");
    const indexSource = readFileSync(indexPath, "utf8");

    expect(indexSource).toContain("ResolvedRoleConfig");
  });
});
