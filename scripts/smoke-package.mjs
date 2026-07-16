import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const npmScript = process.env.npm_execpath;
const npm = npmScript ? process.execPath : "npm";
const npmPrefix = npmScript ? [npmScript] : [];
const runNpm = (args, options = {}) =>
  execFileSync(npm, [...npmPrefix, ...args], { ...(npmScript ? {} : { shell: true }), ...options });
const packageRoot = process.cwd();
const packed = JSON.parse(runNpm(["pack", "--json"], { cwd: packageRoot, encoding: "utf8" }));
const tarball = join(packageRoot, packed[0].filename);
const installRoot = mkdtempSync(join(tmpdir(), "code-ensemble-package-"));

try {
  runNpm(["init", "--yes"], { cwd: installRoot, stdio: "ignore" });
  runNpm(["install", "--ignore-scripts", "--no-save", tarball], { cwd: installRoot, stdio: "inherit" });
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    'const plugin = await import("@cgize/code-ensemble"); const internal = await import("@cgize/code-ensemble/internal"); if (plugin.default?.id !== "@cgize/code-ensemble" || typeof plugin.default?.server !== "function" || typeof internal.readCodeEnsembleState !== "function") process.exit(1)',
  ], { cwd: installRoot, stdio: "inherit" });
} finally {
  rmSync(tarball, { force: true });
  rmSync(installRoot, { recursive: true, force: true });
}
