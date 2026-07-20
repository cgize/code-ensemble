import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "@opencode-ai/plugin";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import codeEnsemblePlugin, { codeEnsemblePlugin as pluginModule } from "../src/index";
import type { SharedPlan } from "../src/plans";

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
    expect(Object.keys(plugin.tool ?? {})).toEqual(["code_ensemble_delegate", "code_ensemble_plan"]);
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
      expect(permission(role)).toMatchObject({ task: "deny", "code_ensemble_*": "deny" });
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

    const result = await plugin.tool!.code_ensemble_delegate!.execute(
      { role: "planner", description: "Plan change", prompt: "Inspect repository" },
      { agent: "director", sessionID: "parent" } as never,
    );
    expect(result).toMatchObject({ metadata: { background: true } });
    expect((result as { output: string }).output).toContain('state="running"');

    releaseFallback();
    const output = await notification;
    expect(agents).toEqual(["planner", fallbackName("planner")]);
    expect(deliveries).toBe(2);
    expect(new Set(deliveryMessageIDs).size).toBe(1);
    expect(output).toContain("fallback plan");
    expect(output).toContain('"usedFallback": true');
  });

  it("does not start delegation from an already cancelled turn", async () => {
    const plugin = await load({ directory: await project(), client: {} } as never);
    const controller = new AbortController();
    controller.abort(new Error("turn cancelled"));
    const result = await plugin.tool!.code_ensemble_delegate!.execute(
      { role: "planner", description: "Plan", prompt: "Plan" },
      { agent: "director", sessionID: "parent", abort: controller.signal } as never,
    );
    expect(parse(result).error).toBe("turn cancelled");
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
    await plugin.tool!.code_ensemble_delegate!.execute(
      { role: "planner", description: "Plan", prompt: "Plan" },
      { agent: "director", sessionID: "parent" } as never,
    );
    await deliveryAttempted;
    await plugin.dispose?.();
  });

  it("shares TASKS.md across sessions and archives a completed plan", async () => {
    const root = await project();
    const plugin = await load({ directory: root } as never);
    const plan = plugin.tool!.code_ensemble_plan!;

    const created = parse(await plan.execute(
      { action: "create", title: "Shared tasklist", tasks: ["Implement feature"] },
      { agent: "director", sessionID: "session-a" } as never,
    ));
    expect(created).toMatchObject({ revision: 1, approved: false, tasks: [{ id: "T001", status: "pending" }] });

    const fromAnotherSession = parse(await plan.execute(
      { action: "get" },
      { agent: "director", sessionID: "session-b" } as never,
    ));
    expect(fromAnotherSession.plan.id).toBe(created.id);

    const approved = parse(await plan.execute(
      { action: "approve", expectedRevision: 1 },
      { agent: "director", sessionID: "session-b" } as never,
    ));
    const completed = parse(await plan.execute(
      { action: "update", expectedRevision: approved.revision, taskID: "T001", status: "completed", evidence: "tests pass" },
      { agent: "director", sessionID: "session-a" } as never,
    ));
    const expanded = parse(await plan.execute(
      { action: "add", expectedRevision: completed.revision, tasks: ["Review final change"] },
      { agent: "director", sessionID: "session-b" } as never,
    ));
    const reviewed = parse(await plan.execute(
      { action: "update", expectedRevision: expanded.revision, taskID: "T002", status: "completed", evidence: "review clean" },
      { agent: "director", sessionID: "session-a" } as never,
    ));
    const closed = parse(await plan.execute(
      { action: "close", expectedRevision: reviewed.revision },
      { agent: "director", sessionID: "session-b" } as never,
    ));

    expect(closed.plan.status).toBe("closed");
    expect(await readFile(closed.archived, "utf8")).toContain("Review final change");
    expect(parse(await plan.execute({ action: "get" }, { agent: "director", sessionID: "session-a" } as never))).toBeNull();
  });

  it("scopes the shared plan to the worktree instead of a nested directory", async () => {
    const root = await project();
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    const plugin = await load({ directory: nested, worktree: root } as never);
    await plugin.tool!.code_ensemble_plan!.execute(
      { action: "create", title: "Worktree plan", tasks: ["Task"] },
      { agent: "director", sessionID: "session" } as never,
    );
    expect(await readFile(join(root, ".code-ensemble", "TASKS.md"), "utf8")).toContain("Worktree plan");
  });

  it("rejects stale plan revisions", async () => {
    const plugin = await load({ directory: await project() } as never);
    const plan = plugin.tool!.code_ensemble_plan!;
    await plan.execute(
      { action: "create", title: "Revision test", tasks: ["Task"] },
      { agent: "director", sessionID: "one" } as never,
    );
    await plan.execute(
      { action: "approve", expectedRevision: 1 },
      { agent: "director", sessionID: "two" } as never,
    );
    const conflict = parse(await plan.execute(
      { action: "update", expectedRevision: 1, taskID: "T001", status: "completed" },
      { agent: "director", sessionID: "one" } as never,
    ));
    expect(conflict.error).toMatch(/revision conflict/);
  });

  it("allows only the director to use custom tools", async () => {
    const plugin = await load({ directory: await project() } as never);
    const planResult = await plugin.tool!.code_ensemble_plan!.execute(
      { action: "get" },
      { agent: "reviewer", sessionID: "session" } as never,
    );
    const delegateResult = await plugin.tool!.code_ensemble_delegate!.execute(
      { role: "planner", description: "Plan", prompt: "Plan" },
      { agent: "reviewer", sessionID: "session" } as never,
    );
    expect(parse(planResult).error).toMatch(/Only the director/);
    expect(parse(delegateResult).error).toMatch(/Only the director/);
  });
});

function fallbackName(role: "planner" | "architect"): string {
  return `code-ensemble-${role}-fallback`;
}

interface ParsedToolResult extends SharedPlan {
  plan: SharedPlan;
  archived: string;
  error: string;
}

function parse(result: unknown): ParsedToolResult {
  if (typeof result !== "string") throw new Error("Expected a JSON string tool result");
  return JSON.parse(result) as ParsedToolResult;
}
