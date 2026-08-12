import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonObject = Record<string, unknown>;

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

export function loadAuthJson(): JsonObject {
  const authPath = join(getAgentDir(), "auth.json");
  try {
    if (existsSync(authPath)) {
      return JSON.parse(readFileSync(authPath, "utf-8"));
    }
  } catch {
    // Missing or malformed auth should render as unavailable, not break pi.
  }
  return {};
}

export function resolveAuthValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("!")) return undefined;
  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) return process.env[trimmed] || undefined;
  if (trimmed.startsWith("$$")) return trimmed.slice(1);
  if (trimmed.startsWith("$!")) return trimmed.slice(1);
  if (trimmed.startsWith("$")) {
    const name = trimmed.slice(1).replace(/^\{(.*)\}$/, "$1");
    return process.env[name] || undefined;
  }
  return trimmed;
}

export function authCredential(...keys: string[]): string | undefined {
  const auth = loadAuthJson();
  for (const key of keys) {
    const entry = auth[key];
    if (typeof entry === "string") {
      const value = resolveAuthValue(entry);
      if (value) return value;
      continue;
    }
    if (entry && typeof entry === "object") {
      for (const field of ["access", "key", "token", "refresh", "cookie"]) {
        const value = resolveAuthValue((entry as JsonObject)[field]);
        if (value) return value;
      }
    }
  }
  return undefined;
}
