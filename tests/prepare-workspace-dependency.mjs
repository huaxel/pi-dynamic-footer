import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyDir = join(packageDir, "..", "opencode-go-usage");
const dependencyManifest = join(dependencyDir, "package.json");
const dependencyEntry = join(dependencyDir, "dist", "index.js");

// Published installs already contain the dependency's dist/ directory. This
// only builds the sibling source package when running inside this monorepo.
if (!existsSync(dependencyManifest)) process.exit(0);

// Ensure node_modules points to the workspace sibling when running in the monorepo.
const targetDir = join(packageDir, "node_modules", "@juanbenjumea", "pi-provider-usage-fetcher");
try {
  let isLinked = false;
  if (existsSync(targetDir)) {
    const stat = lstatSync(targetDir);
    if (stat.isSymbolicLink()) {
      isLinked = true;
    }
  }
  if (!isLinked) {
    mkdirSync(dirname(targetDir), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    symlinkSync(dependencyDir, targetDir, "junction");
  }
} catch {
  // Best-effort linking
}

function isOutdated() {
  if (!existsSync(dependencyEntry)) return true;
  const distMtime = statSync(dependencyEntry).mtimeMs;
  if (statSync(dependencyManifest).mtimeMs > distMtime) return true;

  function hasNewerSource(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (hasNewerSource(full)) return true;
      } else if (entry.name.endsWith(".ts")) {
        if (statSync(full).mtimeMs > distMtime) return true;
      }
    }
    return false;
  }

  return hasNewerSource(dependencyDir);
}

if (!isOutdated()) process.exit(0);

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["run", "build"], {
  cwd: dependencyDir,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Could not build workspace dependency: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
