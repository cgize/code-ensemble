import { afterEach, describe, expect, it } from "vitest";

import { resolveCodeEnsembleConfig, parseOverrides, ConfigValidationError } from "../src/overrides";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeProject(overrides: object) {
  const root = await mkdtemp(resolve(tmpdir(), "code-ensemble-validator-"));
  tempDirs.push(root);
  await writeFile(resolve(root, "code-ensemble.json"), JSON.stringify(overrides));
  return root;
}

describe("parseOverrides", () => {
  it("returns an empty object for the default config", () => {
    expect(parseOverrides({})).toEqual({});
  });

  it("rejects unknown role keys in models", () => {
    expect(() => parseOverrides({ models: { unknown: "x" } })).toThrow(ConfigValidationError);
  });

  it("rejects non-string model values", () => {
    expect(() => parseOverrides({ models: { planner: 42 } })).toThrow(/models\.planner/);
  });

  it("rejects model identifiers without provider and model components", () => {
    expect(() => parseOverrides({ models: { planner: "gpt-5.6-terra" } })).toThrow(/models\.planner/);
    expect(() => parseOverrides({ fallbacks: { planner: ["opencode-go"] } })).toThrow(/fallbacks\.planner\[0\]/);
  });

  it("rejects non-array fallbacks", () => {
    expect(() => parseOverrides({ fallbacks: { planner: "not-array" } })).toThrow(/fallbacks\.planner/);
  });

  it("rejects non-string fallback entries", () => {
    expect(() => parseOverrides({ fallbacks: { planner: [1, 2] } })).toThrow(/fallbacks\.planner\[0\]/);
  });

  it("rejects director in subagents.disable", () => {
    expect(() =>
      parseOverrides({ subagents: { disable: ["director"] } }),
    ).toThrow(/subagents\.disable\[0\]/);
  });

  it("rejects collisions between renamed agents", () => {
    expect(() => parseOverrides({ subagents: { rename: { planner: "reviewer" } } })).toThrow(/unique agent name/);
  });

  it("rejects collisions with reserved fallback agent names", () => {
    expect(() => parseOverrides({ subagents: { rename: { planner: "code-ensemble-planner-fallback" } } })).toThrow(
      /reserved fallback namespace/,
    );
    expect(() => parseOverrides({ subagents: { rename: { reviewer: "code-ensemble-planner-fallback-2" } } })).toThrow(
      /reserved fallback namespace/,
    );
  });

  it("rejects non-positive autoLoopMaxIterations", () => {
    expect(() => parseOverrides({ transitions: { autoLoopMaxIterations: 0 } })).toThrow(/autoLoopMaxIterations/);
    expect(() => parseOverrides({ transitions: { autoLoopMaxIterations: 1.5 } })).toThrow(/autoLoopMaxIterations/);
    expect(() => parseOverrides({ transitions: { autoLoopMaxIterations: 1001 } })).toThrow(/between 1 and 1000/);
  });

  it("rejects non-boolean transition values", () => {
    expect(() => parseOverrides({ transitions: { autoLoop: "yes" } })).toThrow(/transitions\.autoLoop/);
  });

  it("accepts a fully populated config", () => {
    const parsed = parseOverrides({
      models: { planner: "openai/gpt-5.4", reviewer: "opencode-go/glm-5.2" },
      variants: { planner: "high" },
      fallbacks: { planner: ["opencode-go/glm-5.2"] },
      prompts: { director: "./director.md" },
      subagents: { disable: ["researcher"], rename: { tester: "verifier" } },
      transitions: { autoLoop: true, autoLoopMaxIterations: 7, reviewToPlanOnlyWithFindings: false },
    });
    expect(parsed.models?.planner).toBe("openai/gpt-5.4");
    expect(parsed.fallbacks?.planner).toEqual(["opencode-go/glm-5.2"]);
    expect(parsed.subagents?.disable).toEqual(["researcher"]);
    expect(parsed.subagents?.rename?.tester).toBe("verifier");
    expect(parsed.transitions?.autoLoopMaxIterations).toBe(7);
  });
});

describe("resolveCodeEnsembleConfig with hand-written validator", () => {
  it("rejects invalid override files with a clear path", async () => {
    const root = await makeProject({ models: { planner: 42 } });
    expect(() => resolveCodeEnsembleConfig(root)).toThrow(/models\.planner/);
  });

  it("still works for valid overrides (regression)", async () => {
    const root = await makeProject({ models: { reviewer: "opencode-go/glm-5.1" } });
    const resolved = resolveCodeEnsembleConfig(root);
    expect(resolved.roles.reviewer.model).toBe("opencode-go/glm-5.1");
  });

  it("rejects a project prompt that resolves outside the worktree", async () => {
    const root = await makeProject({ prompts: { director: "../outside-director.md" } });
    await expect(() => resolveCodeEnsembleConfig(root)).toThrow(/inside the worktree/);
  });

  it("loads contained prompts when the worktree root is a symlink", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "code-ensemble-prompt-parent-"));
    const root = await mkdtemp(resolve(tmpdir(), "code-ensemble-prompt-root-"));
    const linked = resolve(parent, "project");
    tempDirs.push(parent, root);
    try {
      await symlink(root, linked, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }
    await writeFile(resolve(root, "director.md"), "Linked director prompt");
    await writeFile(resolve(root, "code-ensemble.json"), JSON.stringify({ prompts: { director: "./director.md" } }));

    expect(resolveCodeEnsembleConfig(linked).roles.director.promptText).toContain("Linked director prompt");
  });

  it("rejects prompt files that escape through a symlink", async () => {
    const root = await makeProject({ prompts: { director: "./director.md" } });
    const external = resolve(root, "..", `external-director-${Date.now()}.md`);
    await writeFile(external, "External prompt");
    try {
      await symlink(external, resolve(root, "director.md"), "file");
    } catch (error) {
      await rm(external, { force: true });
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }

    try {
      expect(() => resolveCodeEnsembleConfig(root)).toThrow(/inside the worktree/);
      expect(resolveCodeEnsembleConfig(root, { allowExternalPrompts: true }).roles.director.promptText).toContain("External prompt");
    } finally {
      await rm(external, { force: true });
    }
  });
});
