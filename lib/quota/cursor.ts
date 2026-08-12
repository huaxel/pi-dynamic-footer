import type { QuotaSnapshot, QuotaWindow } from "../quota-provider.ts";
import { clampPercent, formatResetTime, safeError } from "../quota-provider.ts";
import { resolveCursorCookieHeader } from "./cursor-auth.ts";

interface CursorUsageSummary {
  billingCycleEnd?: string;
  individualUsage?: {
    plan?: {
      used?: number;
      limit?: number;
      autoPercentUsed?: number;
      apiPercentUsed?: number;
      totalPercentUsed?: number;
    };
    overall?: { used?: number; limit?: number };
  };
  teamUsage?: {
    pooled?: { used?: number; limit?: number };
  };
}

function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/** Cursor percent fields are already percentage units (0.36 = 0.36%). */
function cursorPercent(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return clampPercent(value);
}

export function parseCursorUsageSummary(summary: CursorUsageSummary): QuotaWindow[] {
  const billingEnd = parseIsoDate(summary.billingCycleEnd);
  const resetsIn = billingEnd ? formatResetTime(billingEnd) : undefined;

  const plan = summary.individualUsage?.plan;
  const autoPercent = cursorPercent(plan?.autoPercentUsed);
  const apiPercent = cursorPercent(plan?.apiPercentUsed);

  const planUsedRaw = Number(plan?.used ?? 0);
  const planLimitRaw = Number(plan?.limit ?? 0);
  const overallUsed = summary.individualUsage?.overall?.used;
  const overallLimit = summary.individualUsage?.overall?.limit;
  const pooledUsed = summary.teamUsage?.pooled?.used;
  const pooledLimit = summary.teamUsage?.pooled?.limit;

  let planPercent: number;
  if (plan?.totalPercentUsed !== undefined) {
    planPercent = cursorPercent(plan.totalPercentUsed) ?? 0;
  } else if (autoPercent !== undefined && apiPercent !== undefined) {
    planPercent = clampPercent((autoPercent + apiPercent) / 2);
  } else if (apiPercent !== undefined) {
    planPercent = apiPercent;
  } else if (autoPercent !== undefined) {
    planPercent = autoPercent;
  } else if (planLimitRaw > 0) {
    planPercent = clampPercent((planUsedRaw / planLimitRaw) * 100);
  } else if (overallLimit && overallLimit > 0 && overallUsed !== undefined) {
    planPercent = clampPercent((overallUsed / overallLimit) * 100);
  } else if (pooledLimit && pooledLimit > 0 && pooledUsed !== undefined) {
    planPercent = clampPercent((pooledUsed / pooledLimit) * 100);
  } else {
    planPercent = 0;
  }

  const windows: QuotaWindow[] = [{ label: "Plan", usedPercent: planPercent, resetsIn }];
  if (autoPercent !== undefined) {
    windows.push({ label: "Auto", usedPercent: autoPercent, resetsIn });
  }
  if (apiPercent !== undefined) {
    windows.push({ label: "API", usedPercent: apiPercent, resetsIn });
  }
  return windows;
}

async function fetchJsonWithCookie(url: string, cookieHeader: string): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Cookie: cookieHeader,
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

export async function fetchCursorUsage(): Promise<QuotaSnapshot> {
  const cookieHeader = resolveCursorCookieHeader();
  if (!cookieHeader) {
    return { provider: "Cursor", windows: [], error: "no-auth", fetchedAt: Date.now() };
  }

  try {
    const data = await fetchJsonWithCookie(
      "https://cursor.com/api/usage-summary",
      cookieHeader,
    );
    const windows = parseCursorUsageSummary(data as CursorUsageSummary);
    return { provider: "Cursor", windows, fetchedAt: Date.now() };
  } catch (error) {
    return { provider: "Cursor", windows: [], error: safeError(error), fetchedAt: Date.now() };
  }
}
