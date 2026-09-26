/**
 * Quota formatting helpers — pure functions with no I/O.
 *
 * Split out of `quota-provider.ts` so tests and future consumers can import
 * formatting without pulling in the whole multi-provider fetch client.
 */

export function formatResetTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) return "unknown";
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

export function formatResetSeconds(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) return undefined;
  return formatResetTime(new Date(Date.now() + Math.max(0, seconds) * 1000));
}

export function clampPercent(value: number): number {
  // NaN has no meaningful clamped value; surface it as 0 so a bad parse
  // never renders as a full bar. ±Infinity clamps to the nearer bound.
  if (Number.isNaN(value)) return 0;
  if (!Number.isFinite(value)) return value > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, value));
}

export function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value <= 1 && value >= 0 ? value * 100 : value;
  return clampPercent(normalized);
}

export function safeError(error: unknown): string {
  if (error instanceof Error && /^HTTP \d+$/.test(error.message)) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  return "unavailable";
}
