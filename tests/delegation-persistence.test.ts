import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DelegationPersistence } from "../src/delegation-persistence";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("DelegationPersistence", () => {
  it("bounds large retained outputs below the state file limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-ensemble-delegation-size-"));
    tempDirs.push(root);
    const persistence = new DelegationPersistence(root);
    await persistence.save("parent", {
      version: 1,
      tasks: Array.from({ length: 100 }, (_, index) => ({
        taskID: `task-${index}`,
        parentSessionID: "parent",
        description: "description",
        role: "planner" as const,
        status: "completed" as const,
        notification: "sent" as const,
        output: "\u0000".repeat(256 * 1024),
      })),
      groups: [],
    });

    const state = await persistence.load("parent");
    expect(state.tasks).toHaveLength(100);
    expect(Buffer.byteLength(state.tasks[0]!.output!, "utf8")).toBeLessThanOrEqual(64 * 1024);
  });
});
