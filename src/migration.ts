import { open, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { safeProjectFile, verifySafeParent, withFileLock } from "./paths.js";
import { sessionScope } from "./scope.js";

export async function claimMigrationOwner(worktree: string, sessionID: string): Promise<boolean> {
  const owner = await safeProjectFile(worktree, ".code-ensemble/migration-owner", { createParent: true });
  const expected = sessionScope(sessionID);

  return withFileLock(owner.path, async () => {
    try {
      return (await readOwner(owner.path)) === expected;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (!(error instanceof Error) || error.message !== "Invalid code-ensemble migration owner file") throw error;
        await rename(owner.path, `${owner.path}.invalid.${Date.now()}.${randomUUID()}`);
      }
    }

    const temporaryPath = `${owner.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${expected}\n`, { encoding: "utf8", flag: "wx" });
      await verifySafeParent(owner.root, temporaryPath);
      await rename(temporaryPath, owner.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return true;
  });
}

export async function hasMigrationOwner(worktree: string): Promise<boolean> {
  let owner: Awaited<ReturnType<typeof safeProjectFile>>;
  try {
    owner = await safeProjectFile(worktree, ".code-ensemble/migration-owner", {
      createParent: false,
      allowMissing: false,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  try {
    await readOwner(owner.path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if (error instanceof Error && error.message === "Invalid code-ensemble migration owner file") return true;
    throw error;
  }
}

async function readOwner(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 128) throw new Error("Invalid code-ensemble migration owner file");
    const value = (await handle.readFile("utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid code-ensemble migration owner file");
    return value;
  } finally {
    await handle.close();
  }
}
