import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyDir = join(packageDir, "..", "opencode-go-usage");
const dependencyManifest = join(dependencyDir, "package.json");
const dependencyEntry = join(dependencyDir, "dist", "index.js");

// Published installs already contain the dependency's dist/ directory. This
// only builds the sibling source package when running inside this monorepo.
if (!existsSync(dependencyManifest) || existsSync(dependencyEntry)) process.exit(0);

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
