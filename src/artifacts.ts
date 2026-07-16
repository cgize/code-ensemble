import { lstat, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, relative, resolve } from "node:path";

import { assertContained, canonicalWorktree, ensureSafeDirectory, verifySafeParent, withFileLock } from "./paths.js";
import { claimMigrationOwner } from "./migration.js";
import { sessionScope } from "./scope.js";

const MAX_ARTIFACT_BYTES = 1_024 * 1_024;
const MAX_ARTIFACTS = 32;
const PHASES = new Set(["plan", "implement", "review"]);

function validateArtifactName(name: string): void {
  if (
    !name ||
    name.length > 200 ||
    name === "." ||
    name === ".." ||
    name.includes("\0") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes(":")
  ) {
    throw new Error("Artifact name must be a single relative file name without separators");
  }
}

function validatePhase(phase?: string): void {
  if (phase !== undefined && !PHASES.has(phase)) throw new Error(`Invalid artifact phase: ${phase}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function moveLegacyEntry(source: string, target: string): Promise<void> {
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) throw new Error(`Legacy artifact path is a symlink: ${source}`);
  if (!await pathExists(target)) {
    await rename(source, target);
    return;
  }

  if (sourceInfo.isDirectory()) {
    await ensureSafeDirectory(await realpath(resolve(target, "..")), target, true);
    for (const entry of await readdir(source)) {
      await moveLegacyEntry(resolve(source, entry), resolve(target, entry));
    }
    await rmdir(source);
    return;
  }

  const extension = source.endsWith(".md") ? ".md" : "";
  const stem = extension ? basename(source, extension) : basename(source);
  await rename(source, resolve(target, "..", `${stem}-legacy-${randomUUID()}${extension}`));
}

async function migrateLegacyArtifacts(
  worktree: string,
  sessionID: string,
  root: string,
  artifactRoot: string,
  sessionRoot: string,
): Promise<void> {
  if (!await claimMigrationOwner(worktree, sessionID)) return;
  await withFileLock(resolve(artifactRoot, ".legacy-migration"), async () => {
    const entries = await readdir(artifactRoot, { withFileTypes: true });
    const legacy = entries.filter((entry) =>
      (entry.isFile() && entry.name.endsWith(".md")) || (entry.isDirectory() && PHASES.has(entry.name)),
    );
    if (legacy.length === 0) return;

    await ensureSafeDirectory(root, sessionRoot, true);
    for (const entry of legacy) {
      await moveLegacyEntry(resolve(artifactRoot, entry.name), resolve(sessionRoot, entry.name));
    }
  });
}

async function safeArtifactDirectory(
  worktree: string,
  sessionID: string,
  phase?: string,
  create = false,
): Promise<{ root: string; path: string; sessionRoot: string }> {
  validatePhase(phase);
  const root = await canonicalWorktree(worktree);
  const codeEnsembleRoot = resolve(root, ".code-ensemble");
  const artifactRoot = resolve(codeEnsembleRoot, "artifacts");
  const sessionRoot = resolve(artifactRoot, sessionScope(sessionID));
  const target = phase ? resolve(sessionRoot, phase) : sessionRoot;

  await ensureSafeDirectory(root, codeEnsembleRoot, create);
  await ensureSafeDirectory(root, artifactRoot, create);
  await migrateLegacyArtifacts(root, sessionID, root, artifactRoot, sessionRoot);
  await ensureSafeDirectory(root, sessionRoot, create || await pathExists(sessionRoot));
  if (phase) await ensureSafeDirectory(root, target, create);

  const realTarget = await realpath(target);
  assertContained(root, realTarget, "Artifact path");
  return { root, path: realTarget, sessionRoot };
}

async function safeArtifactPath(
  worktree: string,
  sessionID: string,
  name: string,
  phase: string | undefined,
  create: boolean,
): Promise<{ root: string; path: string; sessionRoot: string; exists: boolean }> {
  validateArtifactName(name);
  const directory = await safeArtifactDirectory(worktree, sessionID, phase, create);
  const filePath = resolve(directory.path, `${name}.md`);
  assertContained(directory.root, filePath, "Artifact path");
  let exists = false;
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Artifact path is not a regular file: ${filePath}`);
    exists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { root: directory.root, path: filePath, sessionRoot: directory.sessionRoot, exists };
}

async function readRegularFile(filePath: string, maximumBytes: number): Promise<string> {
  const before = await lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Artifact path is not a regular file: ${filePath}`);
  const handle = await open(filePath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Artifact changed while it was being opened: ${filePath}`);
    }
    if (opened.size > maximumBytes) throw new Error("Artifact exceeds the maximum allowed size");
    return handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function collectArtifacts(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    const canonical = await realpath(directory);
    assertContained(root, canonical, "Artifact directory");
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      const fullPath = resolve(canonical, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(fullPath);
    }
  }
  await walk(root);
  return found.sort();
}

export async function readArtifact(
  worktree: string,
  sessionID: string,
  name: string,
  phase?: string,
): Promise<{ path: string; content: string }> {
  const file = await safeArtifactPath(worktree, sessionID, name, phase, false);
  return { path: file.path, content: await readRegularFile(file.path, MAX_ARTIFACT_BYTES) };
}

export async function saveArtifact(
  worktree: string,
  sessionID: string,
  name: string,
  content: string,
  phase?: string,
): Promise<string> {
  if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds the maximum allowed size");
  const initial = await safeArtifactPath(worktree, sessionID, name, phase, true);
  return withFileLock(resolve(initial.sessionRoot, ".artifacts"), async () => {
    const file = await safeArtifactPath(worktree, sessionID, name, phase, true);
    if (!file.exists && (await collectArtifacts(file.sessionRoot)).length >= MAX_ARTIFACTS) {
      throw new Error(`A session may contain at most ${MAX_ARTIFACTS} artifacts`);
    }

    const temporaryPath = `${file.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFileExclusive(temporaryPath, content);
      await verifySafeParent(file.root, temporaryPath);
      await rename(temporaryPath, file.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return file.path;
  });
}

async function writeFileExclusive(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

export async function listSessionArtifacts(
  worktree: string,
  sessionID: string,
): Promise<Array<{ path: string; content: string }>> {
  let directory: Awaited<ReturnType<typeof safeArtifactDirectory>>;
  try {
    directory = await safeArtifactDirectory(worktree, sessionID, undefined, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files = await collectArtifacts(directory.sessionRoot);
  if (files.length > MAX_ARTIFACTS) throw new Error(`A session contains more than ${MAX_ARTIFACTS} artifacts`);
  return Promise.all(files.map(async (filePath) => ({
    path: relative(directory.root, filePath),
    content: await readRegularFile(filePath, MAX_ARTIFACT_BYTES),
  })));
}

export { MAX_ARTIFACT_BYTES, MAX_ARTIFACTS, validateArtifactName };
