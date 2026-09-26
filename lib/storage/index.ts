import { homedir } from "node:os";
import { join } from "node:path";

import { createFileBackend, type FileBackendOptions } from "./file-backend.js";
import { createJsonStore } from "./json-store.js";
import { createJsonlStore } from "./jsonl-store.js";
import { createMemoryBackend } from "./memory-backend.js";
import type { RawBackend, Storage } from "./types.js";

export { createFileBackend, type FileBackendOptions } from "./file-backend.js";
export { createMemoryBackend } from "./memory-backend.js";
export type { JsonStore, JsonlStore, RawBackend, Storage } from "./types.js";

export function createStorage(backend: RawBackend): Storage {
  return {
    json<T>(name: string, options?: { defaults?: T }) {
      return createJsonStore(backend, name, options);
    },
    jsonl(name: string) {
      return createJsonlStore(backend, name);
    },
  };
}

/**
 * Resolve the pi agent data dir, honoring PI_CODING_AGENT_DIR the same way
 * pi's auth layer does. Observability settings live alongside auth.json so a
 * custom agent dir carries them too.
 */
export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function getDefaultObservabilityDir(): string {
  return join(getAgentDir(), "observability");
}

export function createFileStorage(options: { dir: string }): Storage {
  const backend = createFileBackend(options);
  return createStorage(backend);
}

export function createMemoryStorage(): Storage {
  const backend = createMemoryBackend();
  return createStorage(backend);
}
