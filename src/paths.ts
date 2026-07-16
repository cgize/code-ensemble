import { open, lstat, mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5_000;

function isOutside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`);
}

export function assertContained(root: string, candidate: string, label: string): void {
  if (isOutside(root, candidate)) throw new Error(`${label} escapes the project worktree`);
}

export async function canonicalWorktree(worktree: string): Promise<string> {
  return realpath(worktree);
}

export async function ensureSafeDirectory(root: string, target: string, create: boolean): Promise<string> {
  assertContained(root, target, "Directory path");
  const child = relative(root, target);
  let current = root;

  for (const segment of child.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Path is not a safe directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        const created = await lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error(`Path is not a safe directory: ${current}`);
        }
      }
    }

    const canonical = await realpath(current);
    assertContained(root, canonical, "Directory path");
  }

  return realpath(target);
}

export async function safeProjectFile(
  worktree: string,
  file: string,
  options: { createParent?: boolean; allowMissing?: boolean } = {},
): Promise<{ root: string; path: string }> {
  const root = await canonicalWorktree(worktree);
  const candidate = isAbsolute(file) ? resolve(file) : resolve(root, file);
  assertContained(root, candidate, "File path");
  const parent = await ensureSafeDirectory(root, dirname(candidate), options.createParent ?? false);
  const filePath = resolve(parent, basename(candidate));
  assertContained(root, filePath, "File path");

  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Path is not a safe regular file: ${filePath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.allowMissing === false) throw error;
  }

  return { root, path: filePath };
}

export async function verifySafeParent(root: string, filePath: string): Promise<void> {
  const parent = await realpath(dirname(filePath));
  assertContained(root, parent, "File parent");
  const info = await lstat(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Path is not a safe directory: ${parent}`);
}

export async function withFileLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}.lock`;
  const started = Date.now();
  const token = randomUUID();
  const payload = `${process.pid}\n${Date.now()}\n${token}\n`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;

  while (!handle) {
    try {
      const candidate = await open(lockPath, "wx");
      try {
        await candidate.writeFile(payload, "utf8");
        handle = candidate;
      } catch (writeError) {
        await candidate.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw writeError;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        const contents = await readFile(lockPath, "utf8").catch(() => "");
        const ownerPID = Number.parseInt(contents.split("\n", 1)[0] ?? "", 10);
        const validOwner = Number.isInteger(ownerPID) && ownerPID > 0;
        const ownerAlive = validOwner && isProcessAlive(ownerPID);
        if ((validOwner && !ownerAlive) || (!validOwner && Date.now() - info.mtimeMs > STALE_LOCK_MS)) {
          const current = await readFile(lockPath, "utf8").catch(() => undefined);
          if (current === contents) await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for state lock: ${target}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
  }

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    const current = await readFile(lockPath, "utf8").catch(() => undefined);
    if (current === payload) await unlink(lockPath).catch(() => undefined);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
