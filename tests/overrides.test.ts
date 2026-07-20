import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { ConfigValidationError, parseOverrides, resolveCodeEnsembleConfig } from "../src/overrides";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("code-ensemble overrides", () => {
  it("accepts only models, variants, and planner/architect fallbacks", () => {
    expect(parseOverrides({
      models: { reviewer: "opencode-go/glm-5.2" },
      variants: { planner: "high" },
      fallbacks: { architect: ["opencode-go/glm-5.2"] },
    })).toMatchObject({
      models: { reviewer: "opencode-go/glm-5.2" },
      variants: { planner: "high" },
      fallbacks: { architect: ["opencode-go/glm-5.2"] },
    });
  });

  it("rejects removed configuration surfaces", () => {
    expect(() => parseOverrides({ transitions: { autoLoop: true } })).toThrow(ConfigValidationError);
    expect(() => parseOverrides({ subagents: { disable: ["reviewer"] } })).toThrow(ConfigValidationError);
    expect(() => parseOverrides({ prompts: { director: "./director.md" } })).toThrow(ConfigValidationError);
  });

  it("rejects unknown roles and malformed model identifiers", () => {
    expect(() => parseOverrides({ models: { tester: "opencode-go/model" } })).toThrow(/valid role/);
    expect(() => parseOverrides({ models: { planner: "gpt-5" } })).toThrow(/provider\/model/);
    expect(() => parseOverrides({ fallbacks: { reviewer: ["opencode-go/model"] } })).toThrow(/valid role/);
  });

  it("auto-discovers code-ensemble.json", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "code-ensemble-overrides-"));
    tempDirs.push(root);
    await writeFile(resolve(root, "code-ensemble.json"), JSON.stringify({
      models: { reviewer: "opencode-go/custom-reviewer" },
    }));
    expect(resolveCodeEnsembleConfig(root).roles.reviewer.model).toBe("opencode-go/custom-reviewer");
  });
});
