import { createHash } from "node:crypto";

/** Convert an untrusted OpenCode session id into a stable, safe path segment. */
export function sessionScope(sessionID: string): string {
  return createHash("sha256").update(sessionID, "utf8").digest("hex");
}
