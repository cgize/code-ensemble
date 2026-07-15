import { describe, expect, it } from "vitest";

import { delegateWithFallback, fallbackAgentName, isFallbackEligibleError } from "../src/fallback";

function response(text: string) {
  return { data: { info: {}, parts: [{ type: "text", text }] } };
}

describe("quota fallback delegation", () => {
  it("keeps the primary agent when it succeeds", async () => {
    const create = async () => ({ data: { id: "primary-session" } });
    const prompt = async () => response("primary result");

    const result = await delegateWithFallback({ session: { create, prompt } }, {
      parentSessionID: "parent",
      description: "Create plan",
      prompt: "Inspect the repository",
      role: "planner",
      primaryAgent: "planning",
      primaryModel: "openai/gpt-5.6-terra",
      fallbackModel: "opencode-go/glm-5.2",
    });

    expect(result).toMatchObject({
      output: "primary result",
      sessionID: "primary-session",
      model: "openai/gpt-5.6-terra",
      usedFallback: false,
    });
  });

  it("retries the same prompt with the configured fallback after a quota error", async () => {
    const prompts: Array<{ agent: string; text: string }> = [];
    let attempt = 0;
    const create = async () => ({ data: { id: `session-${++attempt}` } });
    const prompt = async (input: { body: { agent: string; parts: Array<{ text: string }> } }) => {
      prompts.push({ agent: input.body.agent, text: input.body.parts[0]!.text });
      if (prompts.length === 1) {
        return { data: { info: { error: { name: "APIError", data: { statusCode: 429, message: "rate limit" } } }, parts: [] } };
      }
      return response("fallback result");
    };

    const result = await delegateWithFallback({ session: { create, prompt } }, {
      parentSessionID: "parent",
      description: "Design API",
      prompt: "Compare the two API options",
      role: "architect",
      primaryAgent: "architect",
      primaryModel: "openai/gpt-5.6-sol",
      fallbackModel: "opencode-go/glm-5.2",
    });

    expect(prompts).toEqual([
      { agent: "architect", text: "Compare the two API options" },
      { agent: fallbackAgentName("architect"), text: "Compare the two API options" },
    ]);
    expect(result).toMatchObject({
      output: "fallback result",
      model: "opencode-go/glm-5.2",
      usedFallback: true,
    });
  });

  it("does not retry errors that are unrelated to quota", async () => {
    let createCount = 0;
    const create = async () => ({ data: { id: `session-${++createCount}` } });
    const prompt = async () => ({
      data: { info: { error: { name: "ProviderAuthError", data: { message: "invalid API key" } } }, parts: [] },
    });

    await expect(
      delegateWithFallback({ session: { create, prompt } }, {
        parentSessionID: "parent",
        description: "Create plan",
        prompt: "Inspect the repository",
        role: "planner",
        primaryAgent: "planner",
        primaryModel: "openai/gpt-5.6-terra",
        fallbackModel: "opencode-go/glm-5.2",
      }),
    ).rejects.toMatchObject({ name: "ProviderAuthError" });
    expect(createCount).toBe(1);
  });

  it("reports both models when the fallback also fails", async () => {
    let createCount = 0;
    const create = async () => ({ data: { id: `session-${++createCount}` } });
    const prompt = async () => {
      if (createCount === 1) {
        return { data: { info: { error: { data: { statusCode: 429, message: "quota exceeded" } } }, parts: [] } };
      }
      return { data: { info: { error: { data: { message: "model unavailable" } } }, parts: [] } };
    };

    await expect(
      delegateWithFallback({ session: { create, prompt } }, {
        parentSessionID: "parent",
        description: "Create plan",
        prompt: "Inspect the repository",
        role: "planner",
        primaryAgent: "planner",
        primaryModel: "openai/gpt-5.6-terra",
        fallbackModel: "opencode-go/glm-5.2",
      }),
    ).rejects.toThrow("Tried openai/gpt-5.6-terra then opencode-go/glm-5.2");
  });

  it("retries when the primary model requires a subscription", async () => {
    let createCount = 0;
    const create = async () => ({ data: { id: `session-${++createCount}` } });
    const prompt = async () =>
      createCount === 1
        ? { data: { info: { error: { data: { statusCode: 403, message: "This model requires a ChatGPT subscription" } } }, parts: [] } }
        : response("fallback result");

    const result = await delegateWithFallback({ session: { create, prompt } }, {
      parentSessionID: "parent",
      description: "Create plan",
      prompt: "Inspect the repository",
      role: "planner",
      primaryAgent: "planner",
      primaryModel: "openai/gpt-5.6-terra",
      fallbackModel: "opencode-go/glm-5.2",
    });

    expect(result).toMatchObject({ model: "opencode-go/glm-5.2", usedFallback: true });
  });

  it("identifies only explicit fallback signals", () => {
    expect(isFallbackEligibleError({ data: { statusCode: 429 } })).toBe(true);
    expect(isFallbackEligibleError({ data: { message: "insufficient_quota" } })).toBe(true);
    expect(isFallbackEligibleError({ data: { message: "model unavailable" } })).toBe(true);
    expect(isFallbackEligibleError({ data: { message: "subscription required" } })).toBe(true);
    expect(isFallbackEligibleError({ data: { statusCode: 500, message: "server error" } })).toBe(false);
    expect(isFallbackEligibleError({ data: { message: "invalid API key" } })).toBe(false);
    expect(isFallbackEligibleError({ data: { message: "request timed out" } })).toBe(false);
  });
});
