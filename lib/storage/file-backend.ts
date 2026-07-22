import { appendFile, chmod, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawBackend } from "./types.js";

export interface FileBackendOptions {
  dir: string;
}

export function createFileBackend(options: FileBackendOptions): RawBackend {
  const { dir } = options;
  let ensured = false;
  let mutationQueue = Promise.resolve();
  const LOCK_TIMEOUT_MS = 30_000;
  const LOCK_RETRY_MS = 25;
  const LOCK_HEARTBEAT_MS = 5_000;

  async function ensureDir() {
    if (ensured) return;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Keep session metadata private on shared machines, including when the
    // directory pre-dates this extension.
    await chmod(dir, 0o700);
    ensured = true;
  }

  async function withFileLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = `${pathFor(name)}.lock`;
    const ownerPath = join(lockPath, "owner");
    const owner = `${process.pid}-${Date.now()}`;
    await ensureDir();

    let acquired = false;
    for (let attempt = 0; attempt < LOCK_TIMEOUT_MS / LOCK_RETRY_MS; attempt++) {
      try {
        await mkdir(lockPath);
        await writeFile(ownerPath, owner, "utf8");
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const heartbeatPath = join(lockPath, "owner");
          const heartbeatStat = await stat(heartbeatPath).catch(() => stat(lockPath));
          const age = Date.now() - heartbeatStat.mtimeMs;
          if (age > LOCK_TIMEOUT_MS) await rm(lockPath, { recursive: true, force: true });
        } catch {
          // The lock may have been released between stat and cleanup.
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }

    if (!acquired) throw new Error(`Timed out acquiring storage lock for ${name}`);

    const heartbeat = setInterval(() => {
      void utimes(ownerPath, new Date(), new Date()).catch(() => undefined);
    }, LOCK_HEARTBEAT_MS);
    try {
      return await operation();
    } finally {
      clearInterval(heartbeat);
      try {
        if ((await readFile(ownerPath, "utf8")) === owner) {
          await rm(lockPath, { recursive: true, force: true });
        }
      } catch {
        // The lock was already recovered or removed.
      }
    }
  }

  function queueMutation<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const run = mutationQueue.then(
      () => withFileLock(name, operation),
      () => withFileLock(name, operation),
    );
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  function pathFor(name: string): string {
    // Store names are part of the public storage API. Keep them as plain file
    // names so a caller cannot escape the configured storage directory.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new Error(`Invalid storage file name: ${name}`);
    }
    return join(dir, name);
  }

  return {
    async read(name) {
      try {
        return await readFile(pathFor(name), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },

    write(name, content) {
      return queueMutation(name, async () => {
        await ensureDir();
        const target = pathFor(name);
        const temp = `${target}.tmp`;
        await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
        await rename(temp, target);
        await chmod(target, 0o600);
      });
    },

    append(name, line) {
      return queueMutation(name, async () => {
        await ensureDir();
        const target = pathFor(name);
        await appendFile(target, `${line}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(target, 0o600);
      });
    },

    async readLines(name, options) {
      const text = await this.read(name);
      if (!text) return [];
      const lines = text.split("\n").filter((l) => l.trim());
      if (options?.last !== undefined && options.last > 0) {
        return lines.slice(-options.last);
      }
      return lines;
    },

    trimLines(name, keepLast) {
      return queueMutation(name, async () => {
        await ensureDir();
        const target = pathFor(name);
        const writeContent = async (content: string) => {
          const temp = `${target}.tmp`;
          await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
          await rename(temp, target);
          await chmod(target, 0o600);
        };
        if (keepLast <= 0) {
          await writeContent("");
          return;
        }
        const text = await this.read(name);
        if (!text) return;
        const lines = text.split("\n").filter((line) => line.trim());
        if (lines.length <= keepLast) return;
        const kept = lines.slice(-keepLast);
        await writeContent(kept.map((line) => `${line}\n`).join(""));
      });
    },
  };
}
