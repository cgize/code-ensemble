import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approveCodeEnsembleTransition,
  proposeCodeEnsembleTransition,
  readCodeEnsembleState,
  resetCodeEnsembleState,
} from "../src/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }))),
  );
});

describe("code-ensemble state", () => {
  it("creates the default state when the file does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-state-"));
    tempDirs.push(root);

    const state = await readCodeEnsembleState(root, ".opencode/state/code-ensemble.json");

    expect(state.phase).toBe("plan");
    expect(state.confirmationPending).toBe(false);
    expect(state.history).toEqual([]);
  });

  it("proposes and approves a phase transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-state-"));
    tempDirs.push(root);

    await proposeCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", "implement");
    const approved = await approveCodeEnsembleTransition(root, ".opencode/state/code-ensemble.json", {
      planSummary: "Plan approved by user",
      openIssues: ["Run implementation smoke test"],
    });

    expect(approved.phase).toBe("implement");
    expect(approved.confirmationPending).toBe(false);
    expect(approved.openIssues).toEqual(["Run implementation smoke test"]);
    expect(approved.history.at(-1)).toMatchObject({ from: "plan", to: "implement" });
  });

  it("backs up invalid JSON before resetting to defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-state-"));
    tempDirs.push(root);

    await mkdir(join(root, ".opencode", "state"), { recursive: true });
    await writeFile(join(root, ".opencode", "state", "code-ensemble.json"), "not-json");

    const state = await resetCodeEnsembleState(root, ".opencode/state/code-ensemble.json");
    const backup = await readFile(join(root, ".opencode", "state", "code-ensemble.json.bak"), "utf8");

    expect(state.phase).toBe("plan");
    expect(backup).toBe("not-json");
  });
});
