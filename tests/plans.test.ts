import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approvePlan, closePlan, createPlan, readActivePlan, renderPlan, updatePlanTask } from "../src/plans";
import { withFileLock } from "../src/paths";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-ensemble-plans-"));
  tempDirs.push(root);
  return root;
}

describe("shared Markdown plan", () => {
  it("creates readable Markdown with stable task IDs", async () => {
    const root = await project();
    const plan = await createPlan(root, "Feature", ["Implement behavior", "Run tests"]);
    const active = await readActivePlan(root);
    expect(plan.tasks.map((task) => task.id)).toEqual(["T001", "T002"]);
    expect(active?.markdown).toContain("# Plan: Feature");
    expect(active?.markdown).toContain("- [ ] **T001** Implement behavior");
  });

  it("serializes concurrent updates through revision checks", async () => {
    const root = await project();
    await createPlan(root, "Concurrent", ["First", "Second"]);
    await approvePlan(root, 1);
    const results = await Promise.allSettled([
      updatePlanTask(root, 2, "T001", "completed", "done"),
      updatePlanTask(root, 2, "T002", "completed", "done"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("requires approval state and every task before close", async () => {
    const root = await project();
    await createPlan(root, "Close", ["Task"]);
    const approved = await approvePlan(root, 1);
    await expect(closePlan(root, approved.revision)).rejects.toThrow(/Every task/);
    const completed = await updatePlanTask(root, approved.revision, "T001", "completed", "verified");
    const closed = await closePlan(root, completed.revision);
    expect(closed.plan.status).toBe("closed");
    expect(await readActivePlan(root)).toBeNull();
  });

  it("does not follow a symlinked .code-ensemble directory", async () => {
    const root = await project();
    const outside = await project();
    try {
      await symlink(outside, join(root, ".code-ensemble"), "junction");
    } catch (error) {
      if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    await expect(createPlan(root, "Unsafe", ["Task"])).rejects.toThrow(/safe directory/);
  });

  it("rejects replacing an active plan", async () => {
    const root = await project();
    await mkdir(join(root, ".code-ensemble"), { recursive: true });
    await createPlan(root, "First", ["Task"]);
    await expect(createPlan(root, "Second", ["Task"])).rejects.toThrow(/already exists/);
  });

  it("rejects manipulated task identifiers", async () => {
    const root = await project();
    await createPlan(root, "Tampered", ["Task"]);
    const file = join(root, ".code-ensemble", "TASKS.md");
    const markdown = await readFile(file, "utf8");
    await writeFile(file, markdown.replace('"id":"T001"', '"id":"T099"'), "utf8");
    await expect(readActivePlan(root)).rejects.toThrow(/invalid task/);
  });

  it("keeps the active plan unchanged when its archive already exists", async () => {
    const root = await project();
    const created = await createPlan(root, "Collision", ["Task"]);
    const approved = await approvePlan(root, created.revision);
    const completed = await updatePlanTask(root, approved.revision, "T001", "completed", "verified");
    const archiveDirectory = join(root, ".code-ensemble", "plans");
    await mkdir(archiveDirectory);
    await writeFile(join(archiveDirectory, `${created.id}.md`), "existing archive", "utf8");

    await expect(closePlan(root, completed.revision)).rejects.toThrow(/different archive/);
    const active = await readActivePlan(root);
    expect(active?.plan).toMatchObject({ status: "active", revision: completed.revision });
  });

  it("finishes a close interrupted after writing its archive", async () => {
    const root = await project();
    const created = await createPlan(root, "Interrupted close", ["Task"]);
    const approved = await approvePlan(root, created.revision);
    const completed = await updatePlanTask(root, approved.revision, "T001", "completed", "verified");
    const archivedPlan = {
      ...completed,
      status: "closed" as const,
      revision: completed.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const archiveDirectory = join(root, ".code-ensemble", "plans");
    await mkdir(archiveDirectory);
    await writeFile(join(archiveDirectory, `${created.id}.md`), renderPlan(archivedPlan), "utf8");

    const closed = await closePlan(root, completed.revision);
    expect(closed.plan).toEqual(archivedPlan);
    expect(await readActivePlan(root)).toBeNull();
  });

  it("cancels a mutation while it waits for the plan lock", async () => {
    const root = await project();
    await createPlan(root, "Cancellation", ["Task"]);
    const file = join(root, ".code-ensemble", "TASKS.md");
    let release!: () => void;
    let acquired!: () => void;
    const acquiredLock = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(file, async () => {
      acquired();
      await gate;
    });
    await acquiredLock;

    const controller = new AbortController();
    const mutation = approvePlan(root, 1, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(mutation).rejects.toThrow("cancelled");
    release();
    await holder;
    expect((await readActivePlan(root))?.plan).toMatchObject({ revision: 1, approved: false });
  });

  it("allows only one writer to reclaim a stale lock", async () => {
    const root = await project();
    const stateDirectory = join(root, ".code-ensemble");
    await mkdir(stateDirectory);
    const lock = join(stateDirectory, "TASKS.md.lock");
    await mkdir(lock);
    const stale = new Date(Date.now() - 10_000);
    await utimes(lock, stale, stale);

    const results = await Promise.allSettled([
      createPlan(root, "First", ["Task"]),
      createPlan(root, "Second", ["Task"]),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
});
