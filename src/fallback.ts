export type FallbackRole = "planner" | "architect";

type FallbackClientResponse<T> = {
  data?: T;
  error?: unknown;
};

type FallbackClient = {
  session: {
    create(input: { body: { parentID: string; title: string } }): Promise<FallbackClientResponse<{ id: string }>>;
    prompt(input: {
      path: { id: string };
      body: { agent: string; parts: Array<{ type: "text"; text: string }> };
    }): Promise<
      FallbackClientResponse<{
        info: { error?: unknown };
        parts: Array<{ type: string; text?: string }>;
      }>
    >;
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

export function fallbackAgentName(role: FallbackRole): string {
  return `code-ensemble-${role}-fallback`;
}

async function runAttempt(
  client: FallbackClient,
  parentSessionID: string,
  description: string,
  prompt: string,
  attempt: DelegationAttempt,
): Promise<Omit<DelegationResult, "model" | "usedFallback">> {
  const created = await client.session.create({
    body: { parentID: parentSessionID, title: `${description} (@${attempt.agent})` },
  });
  if (!created.data) throw created.error ?? new Error("OpenCode did not create the subagent session");

  const response = await client.session.prompt({
    path: { id: created.data.id },
    body: { agent: attempt.agent, parts: [{ type: "text", text: prompt }] },
  });
  if (!response.data) throw response.error ?? new Error("OpenCode did not return a subagent response");
  if (response.data.info.error) throw response.data.info.error;

  const output = [...response.data.parts].reverse().find((part) => part.type === "text")?.text ?? "";
  return { output, sessionID: created.data.id };
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
  },
): Promise<DelegationResult> {
  const primary = { agent: input.primaryAgent, model: input.primaryModel };
  try {
    const result = await runAttempt(client, input.parentSessionID, input.description, input.prompt, primary);
    return { ...result, model: primary.model, usedFallback: false };
  } catch (error) {
    if (!isFallbackEligibleError(error) || !input.fallbackModel) throw error;

    const fallback = { agent: fallbackAgentName(input.role), model: input.fallbackModel };
    try {
      const result = await runAttempt(client, input.parentSessionID, input.description, input.prompt, fallback);
      return { ...result, model: fallback.model, usedFallback: true };
    } catch (fallbackError) {
      throw new Error(
        `Fallback failed for ${input.role}. Tried ${primary.model} then ${fallback.model}: ${errorText(fallbackError)}`,
      );
    }
  }
}
