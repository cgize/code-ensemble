import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { loadDefaultConfig } from "../src/index.js";
import { resolveCodeSwarmConfig } from "../src/overrides";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadDefaultConfig", () => {
  it("returns the default role matrix from the packaged JSON file", () => {
    const config = loadDefaultConfig();

    expect(config.stateFile).toBe(".opencode/state/code-swarm.json");
    expect(config.roles.planner).toMatchObject({
      model: "openai/gpt-5.4",
      variant: "xhigh",
    });
    expect(config.roles.implementer).toMatchObject({
      model: "opencode-go/kimi-k2.7-code",
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

describe("resolveCodeSwarmConfig", () => {
  it("merges project overrides and loads prompt text", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-swarm-"));
    tempDirs.push(root);

    await mkdir(resolve(root, ".code-swarm"), { recursive: true });
    await writeFile(
      resolve(root, "code-swarm.json"),
      JSON.stringify(
        {
          models: { planner: "openai/gpt-5.4-mini" },
          variants: { planner: "high" },
          prompts: { orchestrator: "./.code-swarm/orchestrator.md" },
          subagents: { disable: ["researcher"], rename: { tester: "verifier" } },
        },
        null,
        2,
      ),
    );
    await writeFile(resolve(root, ".code-swarm", "orchestrator.md"), "Custom orchestrator prompt");

    const resolved = resolveCodeSwarmConfig(root, { configPath: "./code-swarm.json" });

    expect(resolved.roles.planner.model).toBe("openai/gpt-5.4-mini");
    expect(resolved.roles.planner.variant).toBe("high");
    expect(resolved.promptText.orchestrator).toContain("Custom orchestrator prompt");
    expect(resolved.disabledSubagents).toEqual(["researcher"]);
    expect(resolved.renamedSubagents.tester).toBe("verifier");
  });

  it("auto-discovers code-swarm.json in the worktree root when configPath is omitted", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-swarm-auto-"));
    tempDirs.push(root);

    await writeFile(
      resolve(root, "code-swarm.json"),
      JSON.stringify({ models: { reviewer: "opencode-go/glm-5.1" } }, null, 2),
    );

    const resolved = resolveCodeSwarmConfig(root);

    expect(resolved.roles.reviewer.model).toBe("opencode-go/glm-5.1");
  });

  it("exports ResolvedRoleConfig from the package barrel", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const indexPath = resolve(testDir, "../src/index.ts");
    const indexSource = readFileSync(indexPath, "utf8");

    expect(indexSource).toContain("ResolvedRoleConfig");
  });
});
