/**
 * Quota Provider — fetch subscription usage for the active pi provider.
 *
 * The visual footer owns presentation; this module owns provider-specific
 * fetching and normalization. Credentials come from existing pi auth/env
 * sources and are never included in errors or logs.
 *
 * Supported providers: Claude, Codex, opencode-go, ClinePass, Umans,
 * GitHub Copilot, Google Gemini, Kimi Coding, Cursor, and CommandCode.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { authCredential, loadAuthJson, resolveAuthValue } from "@juanbenjumea/opencode-go-usage";
import { fetchCommandCodeUsage } from "@juanbenjumea/opencode-go-usage/commandcode.ts";
import { fetchCursorUsage } from "@juanbenjumea/opencode-go-usage/cursor.ts";

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

/* ───── Auth and safe helpers ───── */

type JsonObject = Record<string, any>;

function formatResetTime(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return rem > 0 ? `${days}d${rem}h` : `${days}d`;
}

function formatResetSeconds(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined;
  return formatResetTime(new Date(Date.now() + Math.max(0, seconds) * 1000));
}

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

function clampPercent(value: number): number {
  // NaN has no meaningful clamped value; surface it as 0 so a bad parse
  // never renders as a full bar. ±Infinity clamps to the nearer bound.
  if (Number.isNaN(value)) return 0;
  if (!Number.isFinite(value)) return value > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, value));
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value <= 1 && value >= 0 ? value * 100 : value;
  return clampPercent(normalized);
}

function safeError(error: unknown): string {
  if (error instanceof Error && /^HTTP \d+$/.test(error.message)) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  return "unavailable";
}

/* ───── Provider mapping ───── */

const PROVIDER_MAP: Record<string, string> = {
  anthropic: "claude",
  "claude-bridge": "claude",
  "openai-codex": "codex",
  opencode: "opencode-go",
  "opencode-go": "opencode-go",
  "cline-pass": "cline-pass",
  umans: "umans",
  "github-copilot": "copilot",
  "google-gemini-cli": "gemini",
  "kimi-coding": "kimi",
  cursor: "cursor",
  commandcode: "commandcode",
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
      if (source?.utilization === undefined) return;
      windows.push({
        label,
        usedPercent: normalizePercent(Number(source.utilization)),
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
      windows.push({
        label,
        usedPercent: clampPercent(Number(window.used_percent ?? 0)),
        resetsIn: resetAt ? formatResetTime(resetAt) : formatResetSeconds(Number(window.reset_after_seconds)),
      });
    }

    return { provider: "Codex", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Codex", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}

/* ───── opencode-go (official usage API, legacy dashboard fallback) ───── */

import { fetchUsageApi } from "@juanbenjumea/opencode-go-usage/lib/usage-api.ts";
import { fetchDashboardUsage } from "@juanbenjumea/opencode-go-usage/lib/fetch.ts";
import { parseOpenCodeGoDashboard } from "@juanbenjumea/opencode-go-usage/lib/dashboard.ts";
import type { OpenCodeGoWindow } from "@juanbenjumea/opencode-go-usage/lib/types.ts";

export { parseOpenCodeGoDashboard };

export { resolveAuthValue, formatResetTime, clampPercent, normalizePercent, safeError };

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
      const activeLabel = (globalThis as any).__opencode_go_active_label;
      const active = activeLabel
        ? results.find((r) => r.label === activeLabel)
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
      const g = globalThis as Record<string, unknown>;
      const allExhausted = g.__opencode_go_all_exhausted === true;
      const earliest =
        typeof g.__opencode_go_earliest_reset === "number"
          ? (g.__opencode_go_earliest_reset as number)
          : undefined;
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
  const workspaceId = typeof quotaCfg?.workspaceId === "string" ? quotaCfg.workspaceId.trim() : "";
  const authCookie = typeof quotaCfg?.authCookie === "string" ? quotaCfg.authCookie.trim() : "";
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

/* ───── ClinePass ───── */

interface ClineUsageItem {
  createdAt?: string;
  costUsd?: number;
}

const CLINE_BASE_URL = "https://api.cline.bot";
const CLINE_PAGE_LIMIT = 100;
const CLINE_MAX_PAGES = 100;
function clineUrl(path: string): string {
  return new URL(path, CLINE_BASE_URL).toString();
}

function clineApiKey(explicit?: string): string | undefined {
  return explicit || resolveAuthValue(process.env.CLINE_API_KEY) || authCredential("cline-pass", "clinepass");
}

function parseClineDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function clineWindow(
  now: number,
  label: string,
  durationMs: number,
  limitUnits: number,
  items: ClineUsageItem[],
): QuotaWindow {
  const start = now - durationMs;
  let usedUnits = 0;
  let oldest: number | undefined;

  for (const item of items) {
    const createdAt = parseClineDate(item.createdAt)?.getTime();
    if (createdAt === undefined || createdAt < start || createdAt > now) continue;
    const cost = Number(item.costUsd);
    if (Number.isFinite(cost)) usedUnits += cost;
    oldest = oldest === undefined ? createdAt : Math.min(oldest, createdAt);
  }

  const usedPercent = limitUnits > 0 ? clampPercent((usedUnits / limitUnits) * 100) : 0;
  const resetAt = oldest === undefined ? undefined : new Date(oldest + durationMs);
  return { label, usedPercent, resetsIn: resetAt ? formatResetTime(resetAt) : undefined };
}

async function fetchClineUsage(apiKey: string): Promise<QuotaSnapshot> {
  try {
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "pi-obs-footer" };
    const me = await fetchJson(clineUrl("/api/v1/users/me"), { headers });
    const userId = typeof me.data?.data?.id === "string" ? me.data.data.id : "";
    if (!userId) return { provider: "ClinePass", windows: [], error: "invalid-response", fetchedAt: Date.now() };

    const plans = await fetchJson(clineUrl("/api/v1/plans"), { headers });
    const planList = Array.isArray(plans.data?.data) ? plans.data.data : [];
    const threshold = planList.find((plan: any) =>
      plan?.isActive && plan?.entitlements?.cline_pass?.enabled && plan?.entitlements?.cline_pass?.inferenceCapThreshold,
    )?.entitlements?.cline_pass?.inferenceCapThreshold;
    if (!threshold) return { provider: "ClinePass", windows: [], error: "no-active-plan", fetchedAt: Date.now() };

    const items: ClineUsageItem[] = [];
    let cursor = "";
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

    for (let page = 0; page < CLINE_MAX_PAGES; page++) {
      const url = new URL(clineUrl(`/api/v1/users/${encodeURIComponent(userId)}/usages`));
      url.searchParams.set("limit", String(CLINE_PAGE_LIMIT));
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetchJson(url.toString(), { headers });
      const data = response.data?.data;
      const pageItems = Array.isArray(data?.items) ? data.items : [];
      items.push(...pageItems);

      const oldest = pageItems
        .map((item: ClineUsageItem) => parseClineDate(item.createdAt)?.getTime())
        .filter((value: number | undefined): value is number => value !== undefined)
        .reduce((min: number | undefined, value: number) => min === undefined ? value : Math.min(min, value), undefined);
      cursor = typeof data?.nextToken === "string" ? data.nextToken.trim() : "";
      if (!cursor || pageItems.length === 0 || (oldest !== undefined && oldest < cutoff)) break;
    }

    const now = Date.now();
    return {
      provider: "ClinePass",
      windows: [
        clineWindow(now, "5h", 5 * 60 * 60 * 1000, Number(threshold.last5HoursUsageCostUSDPerUser), items),
        clineWindow(now, "Week", 7 * 24 * 60 * 60 * 1000, Number(threshold.last7daysUsageCostUSDPerUser), items),
        clineWindow(now, "Month", 30 * 24 * 60 * 60 * 1000, Number(threshold.last30daysUsageCostUSDPerUser), items),
      ],
      fetchedAt: now,
    };
  } catch (error) {
    return { provider: "ClinePass", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
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

/* ───── Copilot ───── */

async function fetchCopilotUsage(): Promise<QuotaSnapshot> {
  const token = authCredential("github-copilot");
  if (!token) return { provider: "Copilot", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson("https://api.github.com/copilot_internal/user", {
      headers: {
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
        Accept: "application/json",
        Authorization: `token ${token}`,
      },
    });
    const windows: QuotaWindow[] = [];

    const resetDate = data.quota_reset_date_utc ? new Date(data.quota_reset_date_utc) : undefined;
    const resetsIn = resetDate ? formatResetTime(resetDate) : undefined;

    if (data.quota_snapshots?.premium_interactions) {
      const pi = data.quota_snapshots.premium_interactions;
      const usedPercent = clampPercent(100 - (pi.percent_remaining || 0));
      windows.push({ label: "Premium", usedPercent, resetsIn });
    }

    if (data.quota_snapshots?.chat && !data.quota_snapshots.chat.unlimited) {
      const chat = data.quota_snapshots.chat;
      windows.push({
        label: "Chat",
        usedPercent: clampPercent(100 - (chat.percent_remaining || 0)),
        resetsIn,
      });
    }

    return { provider: "Copilot", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Copilot", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}

/* ───── Gemini ───── */

async function fetchGeminiUsage(): Promise<QuotaSnapshot> {
  let token: string | undefined;

  // Try auth.json first
  token = authCredential("google-gemini-cli");

  // Fallback: ~/.gemini/oauth_creds.json
  if (!token) {
    try {
      const geminiPath = join(homedir(), ".gemini", "oauth_creds.json");
      if (existsSync(geminiPath)) {
        const creds = JSON.parse(readFileSync(geminiPath, "utf-8"));
        token = creds.access_token;
      }
    } catch (error) {
      // File exists but is unreadable or malformed — surface the detail
      if (error instanceof SyntaxError) {
        return { provider: "Gemini", windows: [], error: "gemini-oauth-creds-corrupt", fetchedAt: Date.now() };
      }
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EACCES") {
        return { provider: "Gemini", windows: [], error: "gemini-oauth-creds-permission", fetchedAt: Date.now() };
      }
    }
  }

  if (!token) return { provider: "Gemini", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });

    // Track min remaining fraction per model, plus the associated reset time
    const quotas: Record<string, { frac: number; resetTime?: string }> = {};
    for (const bucket of data.buckets || []) {
      const model = bucket.modelId || "unknown";
      const frac = bucket.remainingFraction ?? 1;
      const existing = quotas[model];
      if (!existing || frac < existing.frac) {
        quotas[model] = { frac, resetTime: bucket.resetTime || bucket.reset_time };
      }
    }

    const windows: QuotaWindow[] = [];
    let proMin = 1, flashMin = 1;
    let hasProModel = false, hasFlashModel = false;
    let proReset: string | undefined, flashReset: string | undefined;

    for (const [model, { frac, resetTime }] of Object.entries(quotas)) {
      if (model.toLowerCase().includes("pro")) {
        hasProModel = true;
        if (frac < proMin) { proMin = frac; proReset = resetTime; }
      }
      if (model.toLowerCase().includes("flash")) {
        hasFlashModel = true;
        if (frac < flashMin) { flashMin = frac; flashReset = resetTime; }
      }
    }

    if (hasProModel) {
      windows.push({
        label: "Pro",
        usedPercent: clampPercent((1 - proMin) * 100),
        resetsIn: proReset ? formatResetTime(new Date(proReset)) : undefined,
      });
    }
    if (hasFlashModel) {
      windows.push({
        label: "Flash",
        usedPercent: clampPercent((1 - flashMin) * 100),
        resetsIn: flashReset ? formatResetTime(new Date(flashReset)) : undefined,
      });
    }

    return { provider: "Gemini", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Gemini", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}

/* ───── Kimi ───── */

async function fetchKimiUsage(): Promise<QuotaSnapshot> {
  const token = resolveAuthValue(process.env.KIMI_API_KEY) || authCredential("kimi-coding");
  if (!token) return { provider: "Kimi Coding", windows: [], error: "no-auth", fetchedAt: Date.now() };

  try {
    const { data } = await fetchJson("https://api.kimi.com/coding/v1/usages", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    const windows: QuotaWindow[] = [];

    for (const limit of data.limits || []) {
      const windowLimit = Number(limit.detail?.limit) || 0;
      const windowRemaining = Number(limit.detail?.remaining) || 0;
      if (windowLimit > 0) {
        const used = windowLimit - windowRemaining;
        const usedPercent = clampPercent((used / windowLimit) * 100);
        const resetDate = limit.detail?.resetTime ? new Date(limit.detail.resetTime) : undefined;
        const label =
          limit.window?.duration && limit.window?.timeUnit === "TIME_UNIT_MINUTE"
            ? `${Math.round(limit.window.duration / 60)}h`
            : "Window";
        windows.push({
          label,
          usedPercent,
          resetsIn: resetDate ? formatResetTime(resetDate) : undefined,
        });
      }
    }

    const weeklyLimit = Number(data.usage?.limit) || 0;
    const weeklyRemaining = Number(data.usage?.remaining) || 0;
    const weeklyResetTime = data.usage?.resetTime;
    if (weeklyLimit > 0) {
      const used = weeklyLimit - weeklyRemaining;
      const usedPercent = clampPercent((used / weeklyLimit) * 100);
      windows.push({
        label: "Week",
        usedPercent,
        resetsIn: weeklyResetTime ? formatResetTime(new Date(weeklyResetTime)) : undefined,
      });
    }

    return { provider: "Kimi Coding", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Kimi Coding", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}

/* ───── Dispatch and cache ───── */

const FETCHERS: Record<string, (options: QuotaFetchOptions) => Promise<QuotaSnapshot>> = {
  claude: async () => fetchClaudeUsage(),
  codex: async () => fetchCodexUsage(),
  "opencode-go": async () => fetchOpencodeGoUsage(),
  "cline-pass": async (options) => {
    const key = clineApiKey(options.apiKey);
    return key ? fetchClineUsage(key) : { provider: "ClinePass", windows: [], error: "no-auth", fetchedAt: Date.now() };
  },
  umans: async (options) => fetchUmansUsage(options.apiKey),
  copilot: async () => fetchCopilotUsage(),
  gemini: async () => fetchGeminiUsage(),
  kimi: async () => fetchKimiUsage(),
  cursor: async () => fetchCursorUsage(),
  commandcode: async () => fetchCommandCodeUsage(),
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
  const result = await fetcher(options);
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
