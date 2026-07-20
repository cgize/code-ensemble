import { describe, expect, it } from "vitest";

import { delegateWithFallback, fallbackAgentName, isFallbackEligibleError } from "../src/fallback";

function response(text: string) {
  return { data: { info: {}, parts: [{ type: "text", text }] } };
}

const base = {
  parentSessionID: "parent",
  description: "Create plan",
  prompt: "Inspect the repository",
  role: "planner" as const,
  primaryAgent: "planner",
  primaryModel: "openai/primary",
  fallbackModels: ["opencode-go/fallback"],
};

describe("ordered model fallback", () => {
  it("returns the primary result without using a fallback", async () => {
    const result = await delegateWithFallback({
      session: {
        create: async () => ({ data: { id: "primary-session" } }),
        prompt: async () => response("primary result"),
      },
    }, base);
    expect(result).toMatchObject({ output: "primary result", usedFallback: false, model: "openai/primary" });
  });

  it("tries eligible fallback models in order", async () => {
    let attempt = 0;
    const agents: string[] = [];
    const result = await delegateWithFallback({
      session: {
        create: async () => ({ data: { id: `session-${++attempt}` } }),
        prompt: async (input: { body: { agent: string } }) => {
          agents.push(input.body.agent);
          if (attempt < 3) return { data: { info: { error: { data: { statusCode: 429, message: "quota exceeded" } } }, parts: [] } };
          return response("final fallback");
        },
      },
    }, { ...base, fallbackModels: ["openai/fallback-one", "openai/fallback-two"] });

    expect(agents).toEqual(["planner", fallbackAgentName("planner"), fallbackAgentName("planner", 2)]);
    expect(result).toMatchObject({ output: "final fallback", model: "openai/fallback-two", usedFallback: true });
  });

  it("does not fallback for unrelated errors", async () => {
    let creates = 0;
    await expect(delegateWithFallback({
      session: {
        create: async () => ({ data: { id: `session-${++creates}` } }),
        prompt: async () => ({ data: { info: { error: { data: { message: "invalid API key" } } }, parts: [] } }),
      },
    }, base)).rejects.toMatchObject({ data: { message: "invalid API key" } });
    expect(creates).toBe(1);
  });

  it("aborts the child session when the parent is cancelled", async () => {
    const controller = new AbortController();
    const aborted: string[] = [];
    const delegation = delegateWithFallback({
      session: {
        create: async () => ({ data: { id: "child" } }),
        prompt: async (input: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
        }),
        abort: async ({ path }: { path: { id: string } }) => {
          aborted.push(path.id);
          return { data: true };
        },
      },
    }, { ...base, signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(delegation).rejects.toThrow("cancelled");
    expect(aborted).toEqual(["child"]);
  });

  it("recognizes only explicit fallback failures", () => {
    expect(isFallbackEligibleError({ data: { statusCode: 429 } })).toBe(true);
    expect(isFallbackEligibleError({ data: { message: "model unavailable" } })).toBe(true);
    expect(isFallbackEligibleError({ data: { message: "invalid API key" } })).toBe(false);
    expect(isFallbackEligibleError({ data: { message: "request timed out" } })).toBe(false);
  });
});
