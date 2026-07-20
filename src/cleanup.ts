type CleanupHandler = {
  name: string;
  priority: number;
  timeoutMs: number;
  run: () => Promise<void> | void;
};

export class CleanupRegistry {
  private readonly handlers: CleanupHandler[] = [];
  private disposing?: Promise<void>;

  register(name: string, run: CleanupHandler["run"], priority = 100, timeoutMs = 5_000): void {
    this.handlers.push({ name, run, priority, timeoutMs });
  }

  dispose(): Promise<void> {
    this.disposing ??= this.runHandlers();
    return this.disposing;
  }

  private async runHandlers(): Promise<void> {
    for (const handler of [...this.handlers].sort((left, right) => left.priority - right.priority)) {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(handler.run),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Cleanup handler ${handler.name} timed out after ${handler.timeoutMs}ms`)),
              handler.timeoutMs,
            );
            timeout.unref?.();
          }),
        ]);
      } catch {
        // Cleanup is best-effort: one failure must not prevent later handlers.
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  }
}
