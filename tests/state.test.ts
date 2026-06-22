import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approveCodeSwarmTransition,
  proposeCodeSwarmTransition,
  readCodeSwarmState,
  resetCodeSwarmState,
} from "../src/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }))),
  );
});

describe("code-swarm state", () => {
  it("creates the default state when the file does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-swarm-state-"));
    tempDirs.push(root);

    const state = await readCodeSwarmState(root, ".opencode/state/code-swarm.json");

    expect(state.phase).toBe("plan");
    expect(state.confirmationPending).toBe(false);
    expect(state.history).toEqual([]);
  });

  it("proposes and approves a phase transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-swarm-state-"));
    tempDirs.push(root);

    await proposeCodeSwarmTransition(root, ".opencode/state/code-swarm.json", "implement");
    const approved = await approveCodeSwarmTransition(root, ".opencode/state/code-swarm.json", {
      planSummary: "Plan approved by user",
      openIssues: ["Run implementation smoke test"],
    });

    expect(approved.phase).toBe("implement");
    expect(approved.confirmationPending).toBe(false);
    expect(approved.openIssues).toEqual(["Run implementation smoke test"]);
    expect(approved.history.at(-1)).toMatchObject({ from: "plan", to: "implement" });
  });

  it("backs up invalid JSON before resetting to defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-swarm-state-"));
    tempDirs.push(root);

    await mkdir(join(root, ".opencode", "state"), { recursive: true });
    await writeFile(join(root, ".opencode", "state", "code-swarm.json"), "not-json");

    const state = await resetCodeSwarmState(root, ".opencode/state/code-swarm.json");
    const backup = await readFile(join(root, ".opencode", "state", "code-swarm.json.bak"), "utf8");

    expect(state.phase).toBe("plan");
    expect(backup).toBe("not-json");
  });
});
