export type FallbackRole = "planner" | "architect";

type FallbackClientResponse<T> = {
  data?: T;
  error?: unknown;
};

type FallbackClient = {
  session: {
    create(input: { body: { parentID: string; title: string }; signal?: AbortSignal }): Promise<FallbackClientResponse<{ id: string }>>;
    prompt(input: {
      path: { id: string };
      body: { agent: string; parts: Array<{ type: "text"; text: string }> };
      signal?: AbortSignal;
    }): Promise<
      FallbackClientResponse<{
        info: { error?: unknown };
        parts: Array<{ type: string; text?: string }>;
      }>
    >;
    abort?(input: { path: { id: string } }): Promise<FallbackClientResponse<boolean>>;
  };
};

type DelegationAttempt = {
  agent: string;
  model: string;
};

export type DelegationResult = {
  output: string;
  sessionID: string;
  model: string;
  usedFallback: boolean;
};

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function errorStatusCode(error: unknown): number | undefined {
  const record = getRecord(error);
  if (!record) return undefined;
  if (typeof record.statusCode === "number") return record.statusCode;
  const data = getRecord(record.data);
  return typeof data?.statusCode === "number" ? data.statusCode : undefined;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  const record = getRecord(error);
  if (!record) return String(error);
  const data = getRecord(record.data);
  return [record.message, record.responseBody, data?.message, data?.responseBody]
    .filter((value): value is string => typeof value === "string")
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
  parentSessionID: string,
  description: string,
  prompt: string,
  attempt: DelegationAttempt,
  signal?: AbortSignal,
): Promise<Omit<DelegationResult, "model" | "usedFallback">> {
  const created = await client.session.create({
    body: { parentID: parentSessionID, title: `${description} (@${attempt.agent})` },
    signal,
  });
  if (!created.data) throw created.error ?? new Error("OpenCode did not create the subagent session");

  const childSessionID = created.data.id;
  let aborting: Promise<unknown> | undefined;
  const abortChild = () => {
    if (!client.session.abort) return Promise.resolve();
    aborting ??= client.session.abort({ path: { id: childSessionID } });
    void aborting.catch(() => undefined);
    return aborting;
  };
  const onAbort = () => void abortChild();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (signal?.aborted) {
      await abortChild().catch(() => undefined);
      throw signal.reason ?? new Error("Delegation aborted");
    }
    const response = await client.session.prompt({
      path: { id: childSessionID },
      body: { agent: attempt.agent, parts: [{ type: "text", text: prompt }] },
      signal,
    });
    if (signal?.aborted) {
      await abortChild().catch(() => undefined);
      throw signal.reason ?? new Error("Delegation aborted");
    }
    if (!response.data) throw response.error ?? new Error("OpenCode did not return a subagent response");
    if (response.data.info.error) throw response.data.info.error;

    const output = response.data.parts
      .filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!output) throw new Error("OpenCode returned an empty subagent response");
    return { output, sessionID: childSessionID };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (signal?.aborted) await aborting?.catch(() => undefined);
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
    fallbackModel?: string;
    fallbackModels?: string[];
    signal?: AbortSignal;
  },
): Promise<DelegationResult> {
  const primary = { agent: input.primaryAgent, model: input.primaryModel };
  try {
    const result = await runAttempt(client, input.parentSessionID, input.description, input.prompt, primary, input.signal);
    return { ...result, model: primary.model, usedFallback: false };
  } catch (error) {
    const fallbackModels = input.fallbackModels ?? (input.fallbackModel ? [input.fallbackModel] : []);
    if (!isFallbackEligibleError(error) || fallbackModels.length === 0) throw error;

    let lastError: unknown = error;
    for (const [index, model] of fallbackModels.entries()) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Delegation aborted");
      const fallback = { agent: fallbackAgentName(input.role, index + 1), model };
      try {
        const result = await runAttempt(client, input.parentSessionID, input.description, input.prompt, fallback, input.signal);
        return { ...result, model: fallback.model, usedFallback: true };
      } catch (fallbackError) {
        lastError = fallbackError;
        if (!isFallbackEligibleError(fallbackError)) throw fallbackError;
      }
    }
    throw new Error(
      `Fallback failed for ${input.role}. Tried ${[primary.model, ...fallbackModels].join(" then ")}: ${errorText(lastError)}`,
    );
  }
}
