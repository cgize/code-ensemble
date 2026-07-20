import type { FallbackRole } from "./types.js";

type ClientResponse<T> = { data?: T; error?: unknown };

type FallbackClient = {
  session: {
    create(input: { body: { parentID: string; title: string }; signal?: AbortSignal }): Promise<ClientResponse<{ id: string }>>;
    prompt(input: {
      path: { id: string };
      body: { agent: string; parts: Array<{ type: "text"; text: string }> };
      signal?: AbortSignal;
    }): Promise<ClientResponse<{ info: { error?: unknown }; parts: Array<{ type: string; text?: string }> }>>;
    abort?(input: { path: { id: string }; signal?: AbortSignal }): Promise<ClientResponse<boolean>>;
  };
};

export type DelegationResult = {
  output: string;
  sessionID: string;
  model: string;
  usedFallback: boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function errorStatusCode(error: unknown): number | undefined {
  const value = record(error);
  if (typeof value?.statusCode === "number") return value.statusCode;
  const data = record(value?.data);
  return typeof data?.statusCode === "number" ? data.statusCode : undefined;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const value = record(error);
  const data = record(value?.data);
  return [value?.message, value?.responseBody, data?.message, data?.responseBody]
    .filter((item): item is string => typeof item === "string")
    .join(" ");
}

export function isFallbackEligibleError(error: unknown): boolean {
  if (errorStatusCode(error) === 429) return true;
  return /\b(quota exceeded|insufficient_quota|rate limit|too many requests|usage limit|capacity exceeded|subscription required|subscription is required|requires a chatgpt subscription|plan required|access denied|not authorized to use|not permitted to use|does not have access|model not found|model unavailable|model is unavailable|model is not available)\b/i.test(
    errorText(error),
  );
}

export function fallbackAgentName(role: FallbackRole, index = 1): string {
  return index === 1 ? `code-ensemble-${role}-fallback` : `code-ensemble-${role}-fallback-${index}`;
}

async function runAttempt(
  client: FallbackClient,
  input: { parentSessionID: string; description: string; prompt: string; agent: string; signal?: AbortSignal },
): Promise<{ output: string; sessionID: string }> {
  const created = await client.session.create({
    body: { parentID: input.parentSessionID, title: `${input.description} (@${input.agent})` },
    signal: input.signal,
  });
  if (!created.data) throw created.error ?? new Error("OpenCode did not create the delegated session");

  const sessionID = created.data.id;
  let aborting: Promise<void> | undefined;
  const abortChild = () => {
    if (!client.session.abort) return Promise.resolve();
    aborting ??= client.session.abort({ path: { id: sessionID }, signal: AbortSignal.timeout(5_000) }).then((response) => {
      if (response.error) throw response.error;
      if (response.data !== true) throw new Error(`OpenCode did not abort session ${sessionID}`);
    });
    return aborting;
  };
  const onAbort = () => void abortChild().catch(() => undefined);
  input.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (input.signal?.aborted) {
      await abortChild().catch(() => undefined);
      throw input.signal.reason ?? new Error("Delegation aborted");
    }
    const response = await client.session.prompt({
      path: { id: sessionID },
      body: { agent: input.agent, parts: [{ type: "text", text: input.prompt }] },
      signal: input.signal,
    });
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Delegation aborted");
    if (!response.data) throw response.error ?? new Error("OpenCode did not return a delegated response");
    if (response.data.info.error) throw response.data.info.error;
    const output = response.data.parts
      .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!output) throw new Error("OpenCode returned an empty delegated response");
    return { output, sessionID };
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    if (input.signal?.aborted) await aborting?.catch(() => undefined);
  }
}

export async function delegateWithFallback(
  client: FallbackClient,
  input: {
    parentSessionID: string;
    description: string;
    prompt: string;
    role: FallbackRole;
    primaryAgent: string;
    primaryModel: string;
    fallbackModels: string[];
    signal?: AbortSignal;
  },
): Promise<DelegationResult> {
  const attempts = [
    { agent: input.primaryAgent, model: input.primaryModel, usedFallback: false },
    ...input.fallbackModels.map((model, index) => ({
      agent: fallbackAgentName(input.role, index + 1),
      model,
      usedFallback: true,
    })),
  ];
  let lastError: unknown;

  for (const attempt of attempts) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("Delegation aborted");
    try {
      const result = await runAttempt(client, { ...input, agent: attempt.agent });
      return { ...result, model: attempt.model, usedFallback: attempt.usedFallback };
    } catch (error) {
      lastError = error;
      if (!isFallbackEligibleError(error)) throw error;
    }
  }

  throw new Error(
    `Fallback failed for ${input.role}. Tried ${attempts.map((attempt) => attempt.model).join(" then ")}: ${errorText(lastError)}`,
  );
}
