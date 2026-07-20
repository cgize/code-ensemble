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

  it("registers exactly seven agents and two custom tools", async () => {
    const plugin = await load({ directory: await project() } as never);
    const config: Config = {};
    await plugin.config?.(config);

    expect(Object.keys(config.agent ?? {}).filter((name) => !name.startsWith("code-ensemble-"))).toEqual([
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
    expect(config.agent?.[fallbackName("planner")]?.hidden).toBe(true);
    expect(config.agent?.researcher).toBeUndefined();
    expect(config.agent?.tester).toBeUndefined();
    expect(config.command).toBeUndefined();
    expect(Object.keys(plugin.tool ?? {})).toEqual(["delegate", "tasks"]);
    expect(plugin.event).toBeUndefined();
    expect(plugin["experimental.chat.system.transform"]).toBeUndefined();
    expect(plugin["experimental.session.compacting"]).toBeUndefined();
  });

  it("keeps least-privilege role boundaries", async () => {
    const plugin = await load({ directory: await project() } as never);
    const config: Config = {};
    await plugin.config?.(config);
    const permission = (role: string) => config.agent?.[role]?.permission as unknown as Record<string, unknown>;

    expect(permission("director")).toMatchObject({ edit: "deny", bash: "deny" });
    expect(permission("explorer")).toMatchObject({ edit: "deny", bash: "deny", glob: "allow" });
    expect(permission("planner")).toMatchObject({ edit: "deny", bash: "deny", webfetch: "allow" });
    expect(permission("architect")).toMatchObject({ edit: "deny", bash: "deny", websearch: "allow" });
    expect(permission("implementer")).toMatchObject({ edit: { "*": "allow", "*.env": "ask" } });
    expect(permission("reviewer")).toMatchObject({ edit: "deny", bash: { "*": "ask" } });
    for (const role of ["explorer", "visualizer", "planner", "architect", "implementer", "reviewer"]) {
      expect(permission(role)).toMatchObject({ task: "deny", tasks: "deny", delegate: "deny" });
    }
  });

  it("returns immediately and delivers an ordered fallback result", async () => {
    const agents: string[] = [];
    let releaseFallback!: () => void;
    const fallbackGate = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    let delivered!: (text: string) => void;
    const notification = new Promise<string>((resolve) => {
      delivered = resolve;
    });
    let attempt = 0;
    let deliveries = 0;
    const deliveryMessageIDs: string[] = [];
    const plugin = await load({
      directory: await project(),
      client: {
        session: {
          create: async () => ({ data: { id: `child-${++attempt}` } }),
          prompt: async (input: { body: { agent: string } }) => {
            agents.push(input.body.agent);
            if (attempt === 1) {
              return { data: { info: { error: { data: { statusCode: 429, message: "quota exceeded" } } }, parts: [] } };
            }
            await fallbackGate;
            return { data: { info: {}, parts: [{ type: "text", text: "fallback plan" }] } };
          },
          status: async () => ({ data: { parent: { type: "idle" } } }),
          promptAsync: async (input: { body: { messageID: string; parts: Array<{ text: string }> } }) => {
            deliveries += 1;
            deliveryMessageIDs.push(input.body.messageID);
            if (deliveries === 1) return { error: new Error("parent busy") };
            delivered(input.body.parts[0]!.text);
            return {};
          },
        },
      },
    } as never);

    const result = await plugin.tool!.delegate!.execute(
      { role: "planner", description: "Plan change", prompt: "Inspect repository" },
      toolContext("director", "parent"),
    );
    expect(result).toMatchObject({ metadata: { background: true }, title: "Delegate to planner · Plan change" });
    expect(outputOf(result)).toContain("Delegating to planner in the background");

    releaseFallback();
    const output = await notification;
    expect(agents).toEqual(["planner", fallbackName("planner")]);
    expect(deliveries).toBe(2);
    expect(new Set(deliveryMessageIDs).size).toBe(1);
    expect(deliveryMessageIDs[0]).toMatch(/^msg_/);
    expect(output).toContain("fallback plan");
    expect(output).toContain("Planner finished");
    expect(output).toContain('"usedFallback": true');
  });

  it("waits for the director session to become idle before delivering a result", async () => {
    let checkedStatus!: () => void;
    const statusChecked = new Promise<void>((resolve) => {
      checkedStatus = resolve;
    });
    let parentIdle = false;
    let deliveries = 0;
    let delivered!: () => void;
    const notification = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const plugin = await load({
      directory: await project(),
      client: {
        session: {
          create: async () => ({ data: { id: "child" } }),
          prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "planner plan" }] } }),
          status: async () => {
            checkedStatus();
            return { data: { parent: { type: parentIdle ? "idle" : "busy" } } };
          },
          promptAsync: async () => {
            deliveries += 1;
            delivered();
            return {};
          },
        },
      },
    } as never);

    await plugin.tool!.delegate!.execute(
      { role: "planner", description: "Plan", prompt: "Plan" },
      toolContext("director", "parent"),
    );
    await statusChecked;
    expect(deliveries).toBe(0);

    parentIdle = true;
    await notification;
    expect(deliveries).toBe(1);
  });

  it("does not start delegation from an already cancelled turn", async () => {
    const plugin = await load({ directory: await project(), client: {} } as never);
    const controller = new AbortController();
    controller.abort(new Error("turn cancelled"));
    const result = await plugin.tool!.delegate!.execute(
      { role: "planner", description: "Plan", prompt: "Plan" },
      toolContext("director", "parent", controller.signal),
    );
    expect(outputOf(result)).toBe("turn cancelled");
    expect(titleOf(result)).toBe("Error");
  });

  it("keeps background delegation alive after the director turn abort signal fires", async () => {
    let delivered!: (text: string) => void;
    const notification = new Promise<string>((resolve) => {
      delivered = resolve;
    });
    const plugin = await load({
      directory: await project(),
      client: {
        session: {
          create: async () => ({ data: { id: "child" } }),
          prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "planner plan" }] } }),
          promptAsync: async (input: { body: { parts: Array<{ text: string }> } }) => {
            delivered(input.body.parts[0]!.text);
            return {};
          },
        },
      },
    } as never);
    const controller = new AbortController();
    const result = await plugin.tool!.delegate!.execute(
      { role: "planner", description: "Plan", prompt: "Plan" },
      toolContext("director", "parent", controller.signal),
    );
    expect(outputOf(result)).toContain("Delegating to planner in the background");
    controller.abort(new Error("turn ended"));
    const output = await notification;
    expect(output).toContain("planner plan");
    expect(output).toContain("state: completed");
  });

  it("stops pending result delivery when the plugin is disposed", async () => {
    let attempted!: () => void;
    const deliveryAttempted = new Promise<void>((resolve) => {
      attempted = resolve;
    });
    const plugin = await load({
      directory: await project(),
      client: {
        session: {
          create: async () => ({ data: { id: "child" } }),
          prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "result" }] } }),
          promptAsync: async () => {
            attempted();
            return { error: new Error("parent busy") };
          },
        },
      },
    } as never);
    await plugin.tool!.delegate!.execute(
      { role: "planner", description: "Plan", prompt: "Plan" },
      toolContext("director", "parent"),
    );
    await deliveryAttempted;
    await plugin.dispose?.();
  });

  it("shares TASKS.md across sessions and archives a completed plan", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const tasks = plugin.tool!.tasks!;
    const director = (sessionID: string) => toolContext("director", sessionID);

    const created = outputOf(await tasks.execute(
      { action: "create", title: "Shared tasklist", tasks: ["Implement feature"] },
      director("session-a"),
    ));
    expect(created).toContain("Plan: Shared tasklist");
    expect(created).toContain("Revision: 1");
    expect(created).toContain("Approved: no");
    expect(created).toContain("T001 Implement feature");

    const fromAnotherSession = outputOf(await tasks.execute({ action: "get" }, director("session-b")));
    expect(fromAnotherSession).toContain("Plan: Shared tasklist");

    const approved = outputOf(await tasks.execute({ action: "approve", expectedRevision: 1 }, director("session-b")));
    expect(approved).toContain("Approved: yes");
    const approvedRevision = revisionOf(approved);

    const completed = outputOf(await tasks.execute(
      {
        action: "update",
        expectedRevision: approvedRevision,
        taskID: "T001",
        status: "completed",
        evidence: "tests pass",
      },
      director("session-a"),
    ));
    expect(completed).toContain("[x] T001");
    expect(completed).toContain("tests pass");
    const completedRevision = revisionOf(completed);

    const expanded = outputOf(await tasks.execute(
      { action: "add", expectedRevision: completedRevision, tasks: ["Review final change"] },
      director("session-b"),
    ));
    expect(expanded).toContain("T002 Review final change");
    const expandedRevision = revisionOf(expanded);

    const reviewed = outputOf(await tasks.execute(
      {
        action: "update",
        expectedRevision: expandedRevision,
        taskID: "T002",
        status: "completed",
        evidence: "review clean",
      },
      director("session-a"),
    ));
    const reviewedRevision = revisionOf(reviewed);

    const closed = outputOf(await tasks.execute(
      { action: "close", expectedRevision: reviewedRevision },
      director("session-b"),
    ));
    expect(closed).toContain("Status: closed");
    expect(closed).toMatch(/Archived to .+\.md/);
    const archivedPath = closed.match(/Archived to (.+\.md)/)?.[1];
    expect(archivedPath).toBeTruthy();
    expect(await readFile(archivedPath!, "utf8")).toContain("Review final change");
    expect(outputOf(await tasks.execute({ action: "get" }, director("session-a")))).toBe("No active plan.");
  });

  it("scopes the shared plan to the worktree instead of a nested directory", async () => {
    const root = await project();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    const plugin = await load({ directory: nested, worktree: root } as never);
    await plugin.tool!.tasks!.execute(
      { action: "create", title: "Worktree plan", tasks: ["Task"] },
      toolContext("director", "session"),
    );
    expect(await readFile(join(root, ".code-ensemble", "TASKS.md"), "utf8")).toContain("Worktree plan");
  });

  it("rejects stale plan revisions", async () => {
    const plugin = await load({ directory: await project() } as never);
    const tasks = plugin.tool!.tasks!;
    await tasks.execute(
      { action: "create", title: "Revision test", tasks: ["Task"] },
      toolContext("director", "one"),
    );
    await tasks.execute(
      { action: "approve", expectedRevision: 1 },
      toolContext("director", "two"),
    );
    const conflict = await tasks.execute(
      { action: "update", expectedRevision: 1, taskID: "T001", status: "completed" },
      toolContext("director", "one"),
    );
    expect(outputOf(conflict)).toMatch(/revision conflict/);
    expect(titleOf(conflict)).toBe("Error");
  });

  it("allows only the director to use custom tools", async () => {
    const plugin = await load({ directory: await project() } as never);
    const planResult = await plugin.tool!.tasks!.execute(
      { action: "get" },
      toolContext("reviewer", "session"),
    );
    const delegateResult = await plugin.tool!.delegate!.execute(
      { role: "planner", description: "Plan", prompt: "Plan" },
      toolContext("reviewer", "session"),
    );
    expect(outputOf(planResult)).toMatch(/Only the director/);
    expect(outputOf(delegateResult)).toMatch(/Only the director/);
  });

  it("uses readable titles for plan actions", async () => {
    const plugin = await load({ directory: await project() } as never);
    const created = await plugin.tool!.tasks!.execute(
      { action: "create", title: "Dashboard", tasks: ["Build UI"] },
      toolContext("director", "session"),
    );
    expect(titleOf(created)).toBe("Create plan · Dashboard");
    const checked = await plugin.tool!.tasks!.execute(
      { action: "get" },
      toolContext("director", "session"),
    );
    expect(titleOf(checked)).toBe("Check active plan");
  });
});

function fallbackName(role: "planner" | "architect"): string {
  return `code-ensemble-${role}-fallback`;
}
