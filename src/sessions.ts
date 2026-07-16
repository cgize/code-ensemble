import type { PluginInput } from "@opencode-ai/plugin";

type SessionClient = PluginInput["client"]["session"];

export class RootSessionResolver {
  private readonly parents = new Map<string, string | undefined>();
  private readonly roots = new Map<string, string>();

  constructor(private readonly client: Pick<SessionClient, "get">) {}

  remember(sessionID: string, parentID?: string): void {
    this.parents.set(sessionID, parentID);
    this.roots.delete(sessionID);
  }

  forget(sessionID: string): void {
    this.parents.delete(sessionID);
    this.roots.delete(sessionID);
  }

  async resolve(sessionID: string, signal?: AbortSignal): Promise<string> {
    const cached = this.roots.get(sessionID);
    if (cached) return cached;

    const visited: string[] = [];
    const seen = new Set<string>();
    let current = sessionID;

    while (true) {
      if (seen.has(current)) throw new Error(`Session parent cycle detected at ${current}`);
      seen.add(current);
      visited.push(current);

      let parentID: string | undefined;
      if (this.parents.has(current)) {
        parentID = this.parents.get(current);
      } else {
        const response = await this.client.get({ path: { id: current }, signal });
        if (!response.data) throw response.error ?? new Error(`OpenCode did not return session ${current}`);
        parentID = response.data.parentID;
        this.parents.set(current, parentID);
      }

      if (!parentID) {
        for (const id of visited) this.roots.set(id, current);
        return current;
      }
      current = parentID;
    }
  }
}
