import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDefaultConfig } from "../src/defaults";
import { resolveCodeEnsembleConfig } from "../src/overrides";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("code-ensemble defaults", () => {
  it("contains exactly the seven supported agents", () => {
    const defaults = loadDefaultConfig();
    expect(Object.keys(defaults.roles)).toEqual([
      "director",
      "explorer",
      "visualizer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
    ]);
    expect(defaults.roles.planner.fallbacks).toEqual(["opencode-go/glm-5.2"]);
    expect(defaults.roles.architect.fallbacks).toEqual(["opencode-go/glm-5.2"]);
  });

  it("merges model, variant, and fallback overrides", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-ensemble-defaults-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "code-ensemble.json"), JSON.stringify({
      models: { planner: "openai/gpt-5.4-mini" },
      variants: { planner: "high" },
      fallbacks: { planner: ["opencode-go/deepseek-v4-flash"] },
    }));

    const config = resolveCodeEnsembleConfig(root);
    expect(config.roles.planner.model).toBe("openai/gpt-5.4-mini");
    expect(config.roles.planner.variant).toBe("high");
    expect(config.fallbacks.planner).toEqual(["opencode-go/deepseek-v4-flash"]);
    expect(config.roles.director.promptText).toContain("explorer: `explorer`");
  });

  it("exports only the root and server package entries", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(Object.keys(packageJson.exports)).toEqual([".", "./server"]);
  });
});
