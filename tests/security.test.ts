import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listSessionArtifacts, MAX_ARTIFACTS, readArtifact, saveArtifact } from "../src/artifacts";
import { readCodeEnsembleState, resetCodeEnsembleState } from "../src/state";
import { DelegationPersistence } from "../src/delegation-persistence";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("artifact boundaries", () => {
  it("rejects traversal and absolute artifact names", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-artifact-"));
    tempDirs.push(root);

    await expect(saveArtifact(root, "session", "../outside", "secret")).rejects.toThrow(/single relative/);
    await expect(saveArtifact(root, "session", "C:\\outside", "secret")).rejects.toThrow(/single relative/);
  });

  it("does not follow a symlinked artifact directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-artifact-link-"));
    const outside = await mkdtemp(join(tmpdir(), "code-ensemble-artifact-outside-"));
    tempDirs.push(root, outside);
    await mkdir(join(root, ".code-ensemble"));
    try {
      await symlink(outside, join(root, ".code-ensemble", "artifacts"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }

    await expect(saveArtifact(root, "session", "plan", "secret")).rejects.toThrow(/safe directory/);
    await expect(readArtifact(root, "session", "plan")).rejects.toThrow(/safe directory/);
  });

  it("migrates legacy artifacts into the first session", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-artifact-legacy-"));
    tempDirs.push(root);
    await mkdir(join(root, ".code-ensemble", "artifacts", "plan"), { recursive: true });
    await writeFile(join(root, ".code-ensemble", "artifacts", "plan", "legacy.md"), "- [x] legacy task");

    const artifacts = await listSessionArtifacts(root, "first-session");
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.content).toContain("legacy task");
    expect(await listSessionArtifacts(root, "second-session")).toEqual([]);
  });

  it("supports a worktree root reached through a symlink or junction", async () => {
    const parent = await mkdtemp(join(tmpdir(), "code-ensemble-linked-parent-"));
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-linked-root-"));
    const linked = join(parent, "project");
    tempDirs.push(parent, root);
    try {
      await symlink(root, linked, "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }

    await saveArtifact(linked, "session", "plan", "linked content");
    expect((await readArtifact(linked, "session", "plan")).content).toBe("linked content");
  });

  it("enforces the artifact count at save time", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-artifact-count-"));
    tempDirs.push(root);
    for (let index = 0; index < MAX_ARTIFACTS; index += 1) {
      await saveArtifact(root, "session", `plan-${index}`, "content");
    }
    await expect(saveArtifact(root, "session", "one-too-many", "content")).rejects.toThrow(/at most/);
  });

  it("enforces the artifact count across concurrent saves", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-artifact-concurrent-count-"));
    tempDirs.push(root);
    for (let index = 0; index < MAX_ARTIFACTS - 1; index += 1) {
      await saveArtifact(root, "session", `plan-${index}`, "content");
    }
    const results = await Promise.allSettled([
      saveArtifact(root, "session", "concurrent-a", "content"),
      saveArtifact(root, "session", "concurrent-b", "content"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await listSessionArtifacts(root, "session")).toHaveLength(MAX_ARTIFACTS);
  });

  it("assigns legacy state and artifacts to the same migration owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-migration-owner-"));
    tempDirs.push(root);
    await mkdir(join(root, ".opencode", "state"), { recursive: true });
    await writeFile(join(root, ".opencode", "state", "code-ensemble.json"), JSON.stringify({ phase: "review" }));
    await mkdir(join(root, ".code-ensemble", "artifacts", "plan"), { recursive: true });
    await writeFile(join(root, ".code-ensemble", "artifacts", "plan", "legacy.md"), "legacy plan");

    expect((await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json", {}, "session-a")).phase).toBe("review");
    expect(await listSessionArtifacts(root, "session-b")).toEqual([]);
    expect((await listSessionArtifacts(root, "session-a"))[0]?.content).toBe("legacy plan");
  });

  it("blocks sessionless state reset after artifact storage claims an owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-artifact-owner-reset-"));
    tempDirs.push(root);
    await mkdir(join(root, ".opencode", "state"), { recursive: true });
    await writeFile(join(root, ".opencode", "state", "code-ensemble.json"), JSON.stringify({ phase: "review" }));
    await saveArtifact(root, "session-a", "plan", "plan");

    await expect(resetCodeEnsembleState(root, ".opencode/state/code-ensemble.json")).rejects.toThrow(/sessionID is required/);
  });

  it("recovers a malformed migration owner without reading unbounded content", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-malformed-owner-"));
    tempDirs.push(root);
    await mkdir(join(root, ".code-ensemble"), { recursive: true });
    await writeFile(join(root, ".code-ensemble", "migration-owner"), "malformed");

    await saveArtifact(root, "session", "plan", "content");
    expect((await readArtifact(root, "session", "plan")).content).toBe("content");
  });
});

describe("state boundaries", () => {
  it("does not follow a symlinked delegation state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-delegation-link-"));
    const outside = await mkdtemp(join(tmpdir(), "code-ensemble-delegation-outside-"));
    tempDirs.push(root, outside);
    await mkdir(join(root, ".opencode", "state"), { recursive: true });
    try {
      await symlink(outside, join(root, ".opencode", "state", "code-ensemble-delegations"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }

    await expect(new DelegationPersistence(root).load("session")).rejects.toThrow(/safe directory/);
  });

  it("does not follow a symlinked state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-state-link-"));
    const outside = await mkdtemp(join(tmpdir(), "code-ensemble-state-outside-"));
    tempDirs.push(root, outside);
    await mkdir(join(root, ".opencode"));
    try {
      await symlink(outside, join(root, ".opencode", "state"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }

    await expect(readCodeEnsembleState(
      root,
      ".opencode/state/code-ensemble.json",
      {},
      "session",
    )).rejects.toThrow(/safe directory/);
  });

  it("does not follow a symlinked state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-state-file-link-"));
    const outside = await mkdtemp(join(tmpdir(), "code-ensemble-state-file-outside-"));
    tempDirs.push(root, outside);
    await mkdir(join(root, ".opencode", "state"), { recursive: true });
    const outsideFile = join(outside, "state.json");
    await writeFile(outsideFile, JSON.stringify({ phase: "review" }));
    try {
      await symlink(outsideFile, join(root, ".opencode", "state", "code-ensemble.json"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES") return;
      throw error;
    }

    await expect(readCodeEnsembleState(root, ".opencode/state/code-ensemble.json")).rejects.toThrow(/safe regular file/);
  });
});
