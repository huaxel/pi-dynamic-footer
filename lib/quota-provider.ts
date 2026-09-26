/**
 * Quota Provider — fetch subscription usage for the active pi provider.
 *
 * The visual footer owns presentation; this module owns provider-specific
 * fetching and normalization. Credentials come from existing pi auth/env
 * sources and are never included in errors or logs.
 *
 * Supported providers: Claude, Codex, opencode-go, Umans, Cursor,
 * CommandCode, and Openference.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { authCredential, loadAuthJson, resolveAuthValue } from "@juanbenjumea/opencode-go-usage";
import { fetchCommandCodeUsage } from "@juanbenjumea/opencode-go-usage/commandcode.ts";
import { fetchCursorUsage } from "@juanbenjumea/opencode-go-usage/cursor.ts";
import { fetchOpenferenceUsage } from "@juanbenjumea/opencode-go-usage/openference.ts";
import { fetchUsageApi } from "@juanbenjumea/opencode-go-usage/lib/usage-api.ts";
import { fetchDashboardUsage } from "@juanbenjumea/opencode-go-usage/lib/fetch.ts";
import { parseOpenCodeGoDashboard } from "@juanbenjumea/opencode-go-usage/lib/dashboard.ts";
import type { OpenCodeGoWindow } from "@juanbenjumea/opencode-go-usage/lib/types.ts";
import { readOpencodeGoQuotaState } from "./opencode-go-integration.ts";
import {
  clampPercent,
  formatResetSeconds,
  formatResetTime,
  normalizePercent,
  safeError,
} from "./quota-format.ts";

export { parseOpenCodeGoDashboard, resolveAuthValue };
export { clampPercent, formatResetTime, normalizePercent, safeError } from "./quota-format.ts";

/* ───── Types ───── */

export interface QuotaWindow {
  label: string;
  usedPercent: number;
  resetsIn?: string;
}

export interface QuotaSnapshot {
  provider: string;
  windows: QuotaWindow[];
  error?: string;
  fetchedAt: number;
}

export interface QuotaFetchOptions {
  /** Resolved by pi's model registry, when available. */
  apiKey?: string;
}

/* ───── Fetch helpers ───── */

type JsonObject = Record<string, any>;

const MAX_JSON_RESPONSE_BYTES = 1_000_000;

async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("response-too-large");
  }

  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("response-too-large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 10_000): Promise<{ response: Response; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow a redirect while an authorization header may be attached.
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { response, data: JSON.parse(await readTextLimited(response, MAX_JSON_RESPONSE_BYTES)) };
  } finally {
    clearTimeout(timer);
  }
}

/* ───── Provider mapping ───── */

const PROVIDER_MAP: Record<string, string> = {
  anthropic: "claude",
  "claude-bridge": "claude",
  "openai-codex": "codex",
  opencode: "opencode-go",
  "opencode-go": "opencode-go",
  umans: "umans",
  cursor: "cursor",
  commandcode: "commandcode",
  openference: "openference",
};

/* ───── Claude ───── */

async function fetchClaudeUsage(): Promise<QuotaSnapshot> {
  let token = authCredential("anthropic");

  if (!token) {
    try {
      // Resolve the macOS keychain credential asynchronously so a slow
      // keychain lookup never blocks the TUI thread.
      const keychain = await new Promise<string>((resolve, reject) => {
        execFile(
          "/usr/bin/security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { encoding: "utf-8", timeout: 2000 },
          (err, stdout) => (err ? reject(err) : resolve(stdout)),
        );
      }).then((s) => s.trim());
      const parsed = JSON.parse(keychain);
      token = parsed.claudeAiOauth?.accessToken;
    } catch {
      // No Claude CLI credential.
    }
  }

  if (!token) return { provider: "Claude", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    const windows: QuotaWindow[] = [];
    const addWindow = (source: any, label: string) => {
      const utilization = Number(source?.utilization);
      if (!Number.isFinite(utilization)) return;
      windows.push({
        label,
        usedPercent: normalizePercent(utilization),
        resetsIn: source.resets_at ? formatResetTime(new Date(source.resets_at)) : undefined,
      });
    };

    addWindow(data.five_hour, "5h");
    addWindow(data.seven_day, "Week");
    // Some subscription variants expose a monthly bucket; do not synthesize
    // one when the endpoint omits it.
    addWindow(data.monthly ?? data.thirty_day ?? data.thirty_day_window, "Month");

    return { provider: "Claude", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Claude", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}

/* ───── OpenAI Codex ───── */

async function fetchCodexUsage(): Promise<QuotaSnapshot> {
  let token = authCredential("openai-codex");
  let accountId = (loadAuthJson() as JsonObject)["openai-codex"]?.accountId;

  if (!token) {
    const codexPath = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
    try {
      const data = JSON.parse(readFileSync(codexPath, "utf-8"));
      token = data.OPENAI_API_KEY || data.tokens?.access_token;
      accountId ||= data.tokens?.account_id;
    } catch {
      // No Codex credential.
    }
  }

  if (!token) return { provider: "Codex", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "User-Agent": "pi-agent",
      Accept: "application/json",
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const { data } = await fetchJson("https://chatgpt.com/backend-api/wham/usage", {
      headers,
    });
    const windows: QuotaWindow[] = [];

    const rateLimit = data.rate_limit ?? {};
    for (const [label, window] of [
      ["5h", rateLimit.primary_window],
      ["Week", rateLimit.secondary_window],
      ["Month", rateLimit.monthly_window ?? rateLimit.tertiary_window],
    ] as const) {
      if (!window) continue;
      const resetAt = typeof window.reset_at === "number" ? new Date(window.reset_at * 1000) : undefined;
      const usedPercent = Number(window.used_percent);
      if (!Number.isFinite(usedPercent)) continue;
      windows.push({
        label,
        usedPercent: clampPercent(usedPercent),
        resetsIn: resetAt ? formatResetTime(resetAt) : formatResetSeconds(Number(window.reset_after_seconds)),
      });
    }

    return { provider: "Codex", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Codex", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}

/* ───── opencode-go (official usage API, legacy dashboard fallback) ───── */

/**
 * Build the QuotaSnapshot from a single account's parsed usage.
 * label is used to distinguish accounts when multiple are tracked.
 */
function buildSnapshot(
  parsed: { rolling: OpenCodeGoWindow | null; weekly: OpenCodeGoWindow | null; monthly: OpenCodeGoWindow | null },
  label?: string,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (parsed.rolling) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(parsed.rolling.usagePercent),
      resetsIn: formatResetSeconds(parsed.rolling.resetInSec),
    });
  }
  if (parsed.weekly) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(parsed.weekly.usagePercent),
      resetsIn: formatResetSeconds(parsed.weekly.resetInSec),
    });
  }
  if (parsed.monthly) {
    windows.push({
      label: "Month",
      usedPercent: clampPercent(parsed.monthly.usagePercent),
      resetsIn: formatResetSeconds(parsed.monthly.resetInSec),
    });
  }
  return windows;
}

/** Helper: effective percent (Infinity if missing). */
function effectivePct(w: OpenCodeGoWindow | null): number {
  return w && Number.isFinite(w.usagePercent) ? w.usagePercent : Infinity;
}

/** Legacy dashboard fallback when no API key is available. */
async function fetchOpencodeGoLegacy(
  workspaceId: string,
  authCookie: string,
): Promise<{ rolling: OpenCodeGoWindow | null; weekly: OpenCodeGoWindow | null; monthly: OpenCodeGoWindow | null; error?: string } | null> {
  if (!workspaceId || !authCookie) return null;
  const usage = await fetchDashboardUsage(workspaceId, authCookie);
  if (!usage.rolling && !usage.weekly && !usage.monthly) return null;
  return usage;
}

async function fetchOpencodeGoUsage(): Promise<QuotaSnapshot> {
  const auth = loadAuthJson() as JsonObject;

  // Try multi-account failover config first.
  const failoverAccounts = Array.isArray(auth["opencode-go-failover"]?.accounts)
    ? auth["opencode-go-failover"].accounts
    : [];
  if (failoverAccounts.length > 0) {
    const results: Array<{
      label: string;
      rolling: OpenCodeGoWindow | null;
      weekly: OpenCodeGoWindow | null;
      monthly: OpenCodeGoWindow | null;
      error?: string;
    }> = [];
    const fallbackQuota = auth["quota-status"]?.["opencode-go"] ?? {};
    const fallbackWorkspaceId = resolveAuthValue(fallbackQuota.workspaceId) || "";
    const fallbackAuthCookie = resolveAuthValue(fallbackQuota.authCookie) || "";
    const fetched = await Promise.all(
      failoverAccounts.map(async (acc: JsonObject) => {
        if (!acc || typeof acc !== "object") return null;
        const label = String(acc.label || "?");
        const key = resolveAuthValue(acc.key);
        // API-first: same key as chat completions, no cookie required.
        if (key) {
          const usage = await fetchUsageApi(key);
          if (!usage.rolling && !usage.weekly && !usage.monthly) return null;
          return { label, ...usage };
        }
        // Legacy cookie path for configs that predate the usage API.
        const workspaceId = (resolveAuthValue(acc.workspaceId) || fallbackWorkspaceId).trim();
        const authCookie = (resolveAuthValue(acc.authCookie) || fallbackAuthCookie).trim();
        const usage = await fetchOpencodeGoLegacy(workspaceId, authCookie);
        if (!usage) return null;
        return { label, ...usage };
      }),
    );
    results.push(...fetched.filter((result: (typeof fetched)[number]): result is (typeof results)[number] => result !== null));

    if (results.length > 0) {
      // Prefer the account the failover extension is actively using.
      const coordination = readOpencodeGoQuotaState();
      const active = coordination.activeLabel
        ? results.find((r) => r.label === coordination.activeLabel)
        : null;
      // Otherwise pick the account with the lowest rolling usage.
      const chosen =
        active ??
        [...results].sort(
          (a, b) => effectivePct(a.rolling) - effectivePct(b.rolling),
        )[0]!;
      const windows = buildSnapshot(chosen, chosen.label);

      // All accounts on cooldown: surface the failover extension's state as a
      // full Cooldown bar with the earliest reset countdown.
      const { allExhausted, earliestReset: earliest } = coordination;
      if (allExhausted && earliest !== undefined) {
        windows.push({
          label: "Cooldown",
          usedPercent: 100,
          resetsIn: formatResetSeconds(
            Math.max(0, Math.floor((earliest - Date.now()) / 1000)),
          ),
        });
      }

      return {
        provider: allExhausted
          ? "opencode-go (all exhausted)"
          : `opencode-go (${chosen.label})`,
        windows,
        fetchedAt: Date.now(),
      };
    }
  }

  // Fall back to single-account quota-status config.
  const quotaCfg = auth["quota-status"]?.["opencode-go"];
  const workspaceId = resolveAuthValue(quotaCfg?.workspaceId)?.trim() || "";
  const authCookie = resolveAuthValue(quotaCfg?.authCookie)?.trim() || "";
  if (!workspaceId || !authCookie) {
    return { provider: "opencode-go", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  const parsed = await fetchOpencodeGoLegacy(workspaceId, authCookie);
  if (!parsed) {
    return { provider: "opencode-go", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }
  if (parsed.error) {
    return { provider: "opencode-go", windows: [], error: parsed.error, fetchedAt: Date.now() };
  }
  return { provider: "opencode-go", windows: buildSnapshot(parsed), fetchedAt: Date.now() };
}

/* ───── Umans ───── */

async function fetchUmansUsage(apiKey?: string): Promise<QuotaSnapshot> {
  const key = apiKey || resolveAuthValue(process.env.UMANS_API_KEY) || authCredential("umans");
  if (!key) return { provider: "Umans", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson("https://api.code.umans.ai/v1/usage", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "pi-obs-footer" },
    });
    const windows: QuotaWindow[] = [];
    const requestLimit = Number(data.limits?.requests?.limit);
    const requestsUsed = Number(data.usage?.requests_in_window);
    if (Number.isFinite(requestLimit) && requestLimit > 0 && Number.isFinite(requestsUsed)) {
      windows.push({ label: "Req", usedPercent: clampPercent((requestsUsed / requestLimit) * 100) });
    }

    const concurrencyLimit = Number(data.limits?.concurrency?.limit);
    const concurrencyUsed = Number(data.usage?.concurrent_sessions);
    if (Number.isFinite(concurrencyLimit) && concurrencyLimit > 0 && Number.isFinite(concurrencyUsed)) {
      windows.push({ label: "Conc", usedPercent: clampPercent((concurrencyUsed / concurrencyLimit) * 100) });
    }

    return { provider: "Umans", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Umans", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}

/* ───── Dispatch and cache ───── */

const FETCHERS: Record<string, (options: QuotaFetchOptions) => Promise<QuotaSnapshot>> = {
  claude: async () => fetchClaudeUsage(),
  codex: async () => fetchCodexUsage(),
  "opencode-go": async () => fetchOpencodeGoUsage(),
  umans: async (options) => fetchUmansUsage(options.apiKey),
  cursor: async () => fetchCursorUsage(),
  commandcode: async () => fetchCommandCodeUsage(),
  openference: async (options) => fetchOpenferenceUsage(options.apiKey),
};

const cache = new Map<string, QuotaSnapshot>();
const CACHE_TTL = 5 * 60_000;

/** Rough ceiling on cached credentials; oldest entries are dropped first. */
const CACHE_MAX_ENTRIES = 64;

/** Drop entries older than CACHE_TTL, and excess ones beyond the cap. */
function evictStaleCache(): void {
  const cutoff = Date.now() - CACHE_TTL;
  for (const [key, snapshot] of cache) {
    if (snapshot.fetchedAt < cutoff) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, snapshot] of cache) {
      if (snapshot.fetchedAt < oldest) {
        oldest = snapshot.fetchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    cache.delete(oldestKey);
  }
}

export function detectProvider(piProvider: string): string | null {
  return PROVIDER_MAP[piProvider] || null;
}

export async function fetchQuota(piProvider: string, options: QuotaFetchOptions = {}): Promise<QuotaSnapshot | null> {
  const key = detectProvider(piProvider);
  if (!key) return null;

  // Only cache requests whose effective credential is supplied by the caller.
  // Providers that resolve credentials internally may switch accounts while pi
  // is running, so a provider-only cache key could show another account's data.
  const cacheKey = options.apiKey
    ? `${key}:${createHash("sha256").update(options.apiKey).digest("hex").slice(0, 16)}`
    : null;
  const cached = cacheKey ? cache.get(cacheKey) : undefined;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached;

  // Opportunistically prune the cache on each miss so stale entries from
  // rotated credentials or account switches don't accumulate forever.
  evictStaleCache();

  const fetcher = FETCHERS[key];
  if (!fetcher) return null;
  let result: QuotaSnapshot;
  try {
    result = await fetcher(options);
  } catch (error) {
    result = {
      provider: key,
      windows: [],
      error: safeError(error),
      fetchedAt: Date.now(),
    };
  }
  if (cacheKey) {
    cache.set(cacheKey, result);
    // Prune after inserting so the cache never exceeds the cap (a bounded,
    // once-in-a-while sweep during an active session is negligible).
    evictStaleCache();
  }
  return result;
}

/** Number of cached quota snapshots — test-support read for cache eviction. */
export function quotaCacheSize(): number {
  return cache.size;
}
