import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir, resolveAuthValue } from "./auth.ts";

export const DEFAULT_QUOTA_SESSIONS_FILE = "quota-sessions.json";

type JsonObject = Record<string, unknown>;

function quotaSessionsPath(): string {
  const override = process.env.PI_QUOTA_SESSIONS_FILE?.trim();
  if (override) return override;
  return join(getAgentDir(), DEFAULT_QUOTA_SESSIONS_FILE);
}

export function loadQuotaSessions(): JsonObject {
  const path = quotaSessionsPath();
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // Missing or malformed sessions should render as unavailable, not break pi.
  }
  return {};
}

/** Cookie header for a provider id in quota-sessions.json (string or { cookie }). */
export function quotaSessionCookie(providerId: string): string | undefined {
  const sessions = loadQuotaSessions();
  const entry = sessions[providerId];
  if (typeof entry === "string") {
    return resolveAuthValue(entry)?.trim();
  }
  if (entry && typeof entry === "object") {
    const cookie = resolveAuthValue((entry as JsonObject).cookie);
    if (cookie) return cookie.trim();
  }
  return undefined;
}
