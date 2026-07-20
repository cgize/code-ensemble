import { describe, expect, it } from "vitest";

import { CleanupRegistry } from "../src/cleanup";

describe("CleanupRegistry", () => {
  it("runs handlers in priority order and isolates failures", async () => {
    const calls: string[] = [];
    const cleanup = new CleanupRegistry();
    cleanup.register("last", () => {
      calls.push("last");
    }, 30);
    cleanup.register("first", () => {
      calls.push("first");
    }, 10);
    cleanup.register("failing", () => {
      calls.push("failing");
      throw new Error("cleanup failed");
    }, 20);

    await cleanup.dispose();
    expect(calls).toEqual(["first", "failing", "last"]);
  });

  it("continues after a handler timeout and is idempotent", async () => {
    let completed = 0;
    const cleanup = new CleanupRegistry();
    cleanup.register("hung", () => new Promise(() => undefined), 10, 10);
    cleanup.register("next", () => {
      completed += 1;
    }, 20);

    await Promise.all([cleanup.dispose(), cleanup.dispose()]);
    expect(completed).toBe(1);
  });
});
