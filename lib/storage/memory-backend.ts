import type { RawBackend } from "./types.js";

export function createMemoryBackend(initial?: Map<string, string>): RawBackend {
  const store = initial ?? new Map<string, string>();
  let mutationQueue = Promise.resolve();

  function queueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = mutationQueue.then(operation, operation);
    mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    async read(name) {
      return store.get(name);
    },

    write(name, content) {
      return queueMutation(async () => {
        store.set(name, content);
      });
    },

    append(name, line) {
      return queueMutation(async () => {
        const existing = store.get(name) ?? "";
        store.set(name, `${existing}${line}\n`);
      });
    },

    async readLines(name, options) {
      const text = store.get(name);
      if (!text) return [];
      const lines = text.split("\n").filter((l) => l.trim());
      if (options?.last !== undefined && options.last > 0) {
        return lines.slice(-options.last);
      }
      return lines;
    },

    trimLines(name, keepLast) {
      return queueMutation(async () => {
        if (keepLast <= 0) {
          store.set(name, "");
          return;
        }
        const text = store.get(name);
        if (!text) return;
        const lines = text.split("\n").filter((line) => line.trim());
        if (lines.length <= keepLast) return;
        const kept = lines.slice(-keepLast);
        store.set(name, kept.map((line) => `${line}\n`).join(""));
      });
    },
  };
}
