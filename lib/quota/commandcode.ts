import type { QuotaSnapshot, QuotaWindow } from "../quota-provider.ts";
import { clampPercent, formatResetTime, safeError } from "../quota-provider.ts";
import { loadAuthJson, resolveAuthValue } from "./auth.ts";
import { codexBarProviderCookie, envCookie } from "./codexbar-config.ts";
import { quotaSessionCookie } from "./web-sessions.ts";

const COMMAND_CODE_ORIGIN = "https://commandcode.ai";
const COMMAND_CODE_API = "https://api.commandcode.ai";
const COMMAND_CODE_SESSION_NAMES = [
  "__Secure-commandcode_prod_.session_token",
  "commandcode_prod_.session_token",
  "__Host-commandcode_prod_.session_token",
  "__Host-better-auth.session_token",
  "__Secure-better-auth.session_token",
  "better-auth.session_token",
];

const COMMAND_CODE_PLANS: Record<string, number> = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-max": 150,
  "individual-ultra": 300,
};

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseDate(value: unknown): Date | undefined {
  const numeric = toNumber(value);
  if (numeric !== undefined && numeric > 0) {
    const seconds = numeric > 10_000_000_000 ? numeric / 1000 : numeric;
    const date = new Date(seconds * 1000);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
  return undefined;
}

function extractSessionCookie(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (!trimmed.includes("=") && !trimmed.includes(";")) {
    return `__Secure-better-auth.session_token=${trimmed}`;
  }

  const pairs: Array<{ name: string; value: string }> = [];
  for (const chunk of trimmed.split(";")) {
    const part = chunk.trim();
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && value) pairs.push({ name, value });
  }

  const byLower = new Map(pairs.map((pair) => [pair.name.toLowerCase(), pair]));
  for (const expected of COMMAND_CODE_SESSION_NAMES) {
    const match = byLower.get(expected.toLowerCase());
    if (match) return `${match.name}=${match.value}`;
  }

  return trimmed;
}

export function resolveCommandCodeCookieHeader(): string | undefined {
  const session = quotaSessionCookie("commandcode");
  if (session) return extractSessionCookie(session);

  const auth = loadAuthJson();
  const entry = auth.commandcode;
  if (entry && typeof entry === "object") {
    const cookie = resolveAuthValue(entry.cookie);
    if (cookie) return extractSessionCookie(cookie);
  }

  const env = envCookie("COMMANDCODE_COOKIE");
  if (env) return extractSessionCookie(env);

  const codexBar = codexBarProviderCookie("commandcode");
  if (codexBar) return extractSessionCookie(codexBar);

  return undefined;
}

function rateWindowFromLimit(
  limit: Record<string, unknown> | undefined,
  label: string,
): QuotaWindow | undefined {
  if (!limit) return undefined;
  const cap = toNumber(limit.cap);
  if (cap === undefined || cap <= 0) return undefined;
  const used = toNumber(limit.used) ?? 0;
  const resetAt = parseDate(limit.resetAt);
  return {
    label,
    usedPercent: clampPercent((used / cap) * 100),
    resetsIn: resetAt ? formatResetTime(resetAt) : undefined,
  };
}

export function parseCommandCodeCredits(data: any): {
  monthlyRemaining: number;
  fiveHour?: QuotaWindow;
  weekly?: QuotaWindow;
} {
  const credits = data?.credits ?? {};
  const windowLimits = data?.windowLimits ?? credits?.windowLimits;
  return {
    monthlyRemaining: toNumber(credits.monthlyCredits) ?? 0,
    fiveHour: rateWindowFromLimit(windowLimits?.fiveHour, "5h"),
    weekly: rateWindowFromLimit(windowLimits?.weekly, "Week"),
  };
}

export function parseCommandCodeSubscription(data: any): {
  planId?: string;
  periodEnd?: Date;
} {
  if (data?.success !== true) return {};
  if (data?.data == null) return {};
  const planId = typeof data.data.planId === "string" ? data.data.planId.toLowerCase() : undefined;
  return {
    planId,
    periodEnd: parseDate(data.data.currentPeriodEnd),
  };
}

export function buildCommandCodeWindows(
  credits: ReturnType<typeof parseCommandCodeCredits>,
  subscription: ReturnType<typeof parseCommandCodeSubscription>,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  if (credits.fiveHour) windows.push(credits.fiveHour);
  if (credits.weekly) windows.push(credits.weekly);

  const monthlyTotal = subscription.planId
    ? COMMAND_CODE_PLANS[subscription.planId]
    : undefined;
  const resetsIn = subscription.periodEnd
    ? formatResetTime(subscription.periodEnd)
    : undefined;

  if (monthlyTotal && monthlyTotal > 0) {
    const used = Math.max(0, Math.min(monthlyTotal, monthlyTotal - credits.monthlyRemaining));
    windows.push({
      label: "Month",
      usedPercent: clampPercent((used / monthlyTotal) * 100),
      resetsIn,
    });
  } else if (credits.monthlyRemaining > 0) {
    windows.push({ label: "Month", usedPercent: 0, resetsIn });
  }

  return windows;
}

async function fetchCommandCodeJson(path: string, cookieHeader: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${COMMAND_CODE_API}${path}`, {
      headers: {
        Accept: "application/json, text/plain, */*",
        Cookie: cookieHeader,
        Origin: COMMAND_CODE_ORIGIN,
        Referer: `${COMMAND_CODE_ORIGIN}/`,
        "User-Agent": "pi-obs-footer",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error("HTTP 401");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCommandCodeUsage(): Promise<QuotaSnapshot> {
  const cookieHeader = resolveCommandCodeCookieHeader();
  if (!cookieHeader) {
    return { provider: "CommandCode", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const creditsData = await fetchCommandCodeJson("/internal/billing/credits", cookieHeader);
    const credits = parseCommandCodeCredits(creditsData);

    let subscription: ReturnType<typeof parseCommandCodeSubscription> = {};
    try {
      const subscriptionData = await fetchCommandCodeJson(
        "/internal/billing/subscriptions",
        cookieHeader,
      );
      subscription = parseCommandCodeSubscription(subscriptionData);
    } catch {
      // Subscription enrichment is optional; credits windows still render.
    }

    const windows = buildCommandCodeWindows(credits, subscription);
    return { provider: "CommandCode", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "CommandCode", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
