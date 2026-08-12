import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadAuthJson, resolveAuthValue } from "./auth.ts";
import { codexBarProviderCookie, envCookie } from "./codexbar-config.ts";
import { quotaSessionCookie } from "./web-sessions.ts";

function cursorDbPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base =
    xdg && xdg.startsWith("/") ? xdg : join(homedir(), ".config");
  return join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

function readSqliteValue(dbPath: string, key: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  try {
    const value = execFileSync(
      "sqlite3",
      [dbPath, `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}' LIMIT 1;`],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000 },
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function jwtPayload(accessToken: string): Record<string, unknown> | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  let payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  payload += "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  } catch {
    return undefined;
  }
}

function cursorUserIdFromToken(accessToken: string): string | undefined {
  const json = jwtPayload(accessToken);
  const sub = typeof json?.sub === "string" ? json.sub : "";
  const userId = sub.split("|").filter(Boolean).pop();
  if (!userId || !/^[A-Za-z0-9._-]+$/.test(userId)) return undefined;
  return userId;
}

function tokenExpiresAt(accessToken: string): number | undefined {
  const json = jwtPayload(accessToken);
  const exp = json?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
}

export function cursorCookieFromAccessToken(accessToken: string): string | undefined {
  const trimmed = accessToken.trim();
  if (!trimmed) return undefined;
  const exp = tokenExpiresAt(trimmed);
  if (exp !== undefined && exp * 1000 <= Date.now() + 60_000) return undefined;
  const userId = cursorUserIdFromToken(trimmed);
  if (!userId) return undefined;
  return `WorkosCursorSessionToken=${userId}%3A%3A${trimmed}`;
}

export function resolveCursorCookieHeader(): string | undefined {
  const session = quotaSessionCookie("cursor");
  if (session) return session;

  const auth = loadAuthJson();
  const entry = auth.cursor;
  if (entry && typeof entry === "object") {
    const cookie = resolveAuthValue(entry.cookie);
    if (cookie) return cookie.trim();
  }

  const env = envCookie("CURSOR_COOKIE");
  if (env) return env;

  const codexBar = codexBarProviderCookie("cursor");
  if (codexBar) return codexBar;

  const accessToken = readSqliteValue(cursorDbPath(), "cursorAuth/accessToken");
  if (accessToken) return cursorCookieFromAccessToken(accessToken);

  return undefined;
}
