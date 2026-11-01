/**
 * Quota Provider — fetch subscription usage for the active pi provider.
 *
 * The visual footer owns presentation; provider-specific fetching and
 * normalization are delegated to the shared @juanbenjumea/pi-provider-usage-fetcher package.
 * Credentials come from existing pi auth/env sources and are never included in errors or logs.
 *
 * Supported providers: Claude, Codex, opencode-go, ClinePass, Umans,
 * GitHub Copilot, Google Gemini, Kimi Coding, Cursor, CommandCode, and Openference.
 */

import { createHash } from "node:crypto";
import {
  detectProvider,
  fetchProviderUsage,
  fetchOpencodeGoUsage as fetchSharedOpencodeGoUsage,
  fetchUsageApi,
  fetchDashboardUsage,
  parseOpenCodeGoDashboard,
  buildOpencodeGoWindows,
  resolveAuthValue,
  formatResetTime,
  formatResetSeconds,
  clampPercent,
  normalizePercent,
  safeError,
  loadAuthJson,
  type QuotaSnapshot,
  type QuotaWindow,
  type QuotaFetchOptions,
  type OpenCodeGoWindow,
} from "@juanbenjumea/pi-provider-usage-fetcher";
import { readOpencodeGoQuotaState } from "./opencode-go-integration.ts";

export type { QuotaWindow, QuotaSnapshot, QuotaFetchOptions };
export {
  detectProvider,
  fetchProviderUsage,
  parseOpenCodeGoDashboard,
  resolveAuthValue,
  formatResetTime,
  clampPercent,
  normalizePercent,
  safeError,
};

type JsonObject = Record<string, any>;

/**
 * Fetch usage for opencode-go, honoring the multi-account failover extension
 * and its process-level cooldown/exhaustion coordination before falling back
 * to standard single-account resolution.
 */
async function fetchOpencodeGoUsage(options: QuotaFetchOptions = {}): Promise<QuotaSnapshot> {
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
        if (!workspaceId || !authCookie) return null;
        const usage = await fetchDashboardUsage(workspaceId, authCookie);
        if (!usage.rolling && !usage.weekly && !usage.monthly) return null;
        return { label, ...usage };
      }),
    );
    results.push(...fetched.filter((result): result is (typeof results)[number] => result !== null));

    if (results.length > 0) {
      // Prefer the account the failover extension is actively using.
      const coordination = readOpencodeGoQuotaState();
      const active = coordination.activeLabel
        ? results.find((r) => r.label === coordination.activeLabel)
        : null;
      // Otherwise pick the account with the lowest rolling usage.
      const effectivePct = (w: OpenCodeGoWindow | null) => (w && Number.isFinite(w.usagePercent) ? w.usagePercent : Infinity);
      const chosen =
        active ??
        [...results].sort(
          (a, b) => effectivePct(a.rolling) - effectivePct(b.rolling),
        )[0]!;
      const windows = buildOpencodeGoWindows(chosen);

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

  // Fall back to standard single-account resolution from shared package.
  return fetchSharedOpencodeGoUsage(options);
}

/* ───── Caching and dispatch ───── */

const cache = new Map<string, QuotaSnapshot>();
const CACHE_TTL = 5 * 60_000;
const CACHE_MAX_ENTRIES = 64;

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

  evictStaleCache();

  let result: QuotaSnapshot | null;
  try {
    if (key === "opencode-go") {
      result = await fetchOpencodeGoUsage(options);
    } else {
      result = await fetchProviderUsage(key, options);
    }
  } catch (error) {
    result = {
      provider: key,
      windows: [],
      error: safeError(error),
      fetchedAt: Date.now(),
    };
  }

  if (!result) return null;

  if (cacheKey) {
    cache.set(cacheKey, result);
    evictStaleCache();
  }
  return result;
}

/** Number of cached quota snapshots — test-support read for cache eviction. */
export function quotaCacheSize(): number {
  return cache.size;
}
