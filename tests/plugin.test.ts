import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import codeEnsemblePlugin, { codeEnsemblePlugin as pluginModule } from "../src/index";

const server = pluginModule.server;
const tempDirs: string[] = [];
const plugins: Array<Awaited<ReturnType<typeof server>>> = [];

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-ensemble-plugin-"));
  tempDirs.push(root);
  return root;
}

async function load(input: Parameters<typeof server>[0]) {
  const plugin = await server(input, {});
  plugins.push(plugin);
  return plugin;
}

function toolContext(agent: string, sessionID: string, abort?: AbortSignal) {
  return {
    agent,
    sessionID,
    abort,
    metadata() {},
  } as never;
}

function outputOf(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object" && "output" in result) {
    return String((result as { output: unknown }).output);
  }
  throw new Error("Expected a tool result with output");
}

function titleOf(result: unknown): string | undefined {
  if (result && typeof result === "object" && "title" in result) {
    return String((result as { title: unknown }).title);
  }
  return undefined;
}

function revisionOf(text: string): number {
  const match = text.match(/Revision:\s*(\d+)/);
  if (!match) throw new Error(`Revision not found in:\n${text}`);
  return Number(match[1]);
}

afterEach(async () => {
  await Promise.all(plugins.splice(0).map((plugin) => plugin.dispose?.()));
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("codeEnsemblePlugin", () => {
  it("exports the OpenCode npm plugin shape", () => {
    expect(codeEnsemblePlugin).toMatchObject({ id: "@cgize/code-ensemble", server });
    expect(typeof server).toBe("function");
  });

  it("registers exactly seven agents and the plan tool", async () => {
    const plugin = await load({ directory: await project() } as never);
    const config: Config = {};
    await plugin.config?.(config);

    expect(Object.keys(config.agent ?? {})).toEqual([
      "director",
      "explorer",
      "visualizer",
      "planner",
      "architect",
      "implementer",
      "reviewer",
    ]);
    expect(config.agent?.director?.mode).toBe("primary");
    expect(config.agent?.planner?.model).toBe("openai/gpt-5.6-terra");
    expect(config.agent?.planner?.mode).toBe("subagent");
    expect(config.agent?.architect?.mode).toBe("subagent");
    expect(config.agent?.researcher).toBeUndefined();
    expect(config.agent?.tester).toBeUndefined();
    expect(config.command).toBeUndefined();
    expect(Object.keys(plugin.tool ?? {})).toEqual(["plan"]);
    expect(plugin.event).toBeUndefined();
    expect(plugin["experimental.chat.system.transform"]).toBeUndefined();
    expect(plugin["experimental.session.compacting"]).toBeUndefined();
  });

  it("keeps least-privilege role boundaries", async () => {
    const plugin = await load({ directory: await project() } as never);
    const config: Config = {};
    await plugin.config?.(config);
    const permission = (role: string) => config.agent?.[role]?.permission as unknown as Record<string, unknown>;

    expect(permission("director")).toMatchObject({
      edit: "deny",
      bash: "deny",
      task: {
        "*": "deny",
        explorer: "allow",
        visualizer: "allow",
        planner: "allow",
        architect: "allow",
        implementer: "allow",
        reviewer: "allow",
      },
    });
    expect(permission("explorer")).toMatchObject({ edit: "deny", bash: "deny", glob: "allow" });
    expect(permission("planner")).toMatchObject({ edit: "deny", bash: "deny", webfetch: "allow" });
    expect(permission("architect")).toMatchObject({ edit: "deny", bash: "deny", websearch: "allow" });
    expect(permission("implementer")).toMatchObject({ edit: { "*": "allow", "*.env": "ask" } });
    expect(permission("reviewer")).toMatchObject({ edit: "deny", bash: { "*": "ask" } });
    for (const role of ["explorer", "visualizer", "planner", "architect", "implementer", "reviewer"]) {
      expect(permission(role)).toMatchObject({ task: "deny", plan: "deny" });
    }
  });

  it("shares TASKS.md across sessions and archives a completed plan", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.plan!;
    const director = (sessionID: string) => toolContext("director", sessionID);

    const created = await plan.execute(
      { action: "create", title: "Dashboard", tasks: ["Define model", "Build UI", "Review"] },
      director("session-a"),
    );
    expect(outputOf(created)).toContain("Plan: Dashboard");
    expect(revisionOf(outputOf(created))).toBe(1);

    const approved = await plan.execute(
      { action: "approve", expectedRevision: 1 },
      director("session-b"),
    );
    expect(outputOf(approved)).toContain("Approved: yes");
    expect(revisionOf(outputOf(approved))).toBe(2);

    for (const [taskID, status, evidence] of [
      ["T001", "completed", "schema ready"],
      ["T002", "completed", "ui shipped"],
      ["T003", "completed", "review clean"],
    ] as const) {
      const updated = await plan.execute(
        { action: "update", expectedRevision: revisionOf(outputOf(await plan.execute({ action: "get" }, director("s")))), taskID, status, evidence },
        director("session-c"),
      );
      expect(outputOf(updated)).toContain(taskID);
    }

    const current = await plan.execute({ action: "get" }, director("session-d"));
    const closed = await plan.execute(
      { action: "close", expectedRevision: revisionOf(outputOf(current)) },
      director("session-e"),
    );
    expect(outputOf(closed)).toMatch(/Archived to/);
    expect(await readFile(join(root, ".code-ensemble", "TASKS.md"), "utf8").catch(() => "")).toBe("");
  });

  it("scopes the shared plan to the worktree instead of a nested directory", async () => {
    const root = await project();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    const plugin = await load({ directory: nested, worktree: root } as never);
    await plugin.tool!.plan!.execute(
      { action: "create", title: "Worktree plan", tasks: ["Task"] },
      toolContext("director", "session"),
    );
    expect(await readFile(join(root, ".code-ensemble", "TASKS.md"), "utf8")).toContain("Worktree plan");
  });

  it("rejects stale plan revisions", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.plan!;
    await plan.execute(
      { action: "create", title: "Revision test", tasks: ["Task"] },
      toolContext("director", "one"),
    );
    await plan.execute(
      { action: "approve", expectedRevision: 1 },
      toolContext("director", "two"),
    );
    const conflict = await plan.execute(
      { action: "update", expectedRevision: 1, taskID: "T001", status: "completed" },
      toolContext("director", "one"),
    );
    expect(outputOf(conflict)).toMatch(/revision conflict/);
    expect(titleOf(conflict)).toBe("Error");
  });

  it("allows only the director to use custom tools", async () => {
    const plugin = await load({ directory: await project() } as never);
    const planResult = await plugin.tool!.plan!.execute(
      { action: "get" },
      toolContext("reviewer", "session"),
    );
    expect(outputOf(planResult)).toMatch(/Only the director/);
  });

  it("uses readable titles for plan actions", async () => {
    const plugin = await load({ directory: await project() } as never);
    const created = await plugin.tool!.plan!.execute(
      { action: "create", title: "Dashboard", tasks: ["Build UI"] },
      toolContext("director", "session"),
    );
    expect(titleOf(created)).toBe("Create plan · Dashboard");
    const checked = await plugin.tool!.plan!.execute(
      { action: "get" },
      toolContext("director", "session"),
    );
    expect(titleOf(checked)).toBe("Check active plan");
  });
});
