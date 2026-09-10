import { homedir } from "node:os";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const value = Math.abs(n);
  // Promote values that would round to 1000.0k so the display never crosses
  // the unit boundary awkwardly.
  if (value >= 999_950) return `${sign}${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${sign}${(value / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function shortenPath(p: string): string {
  const home = homedir();
  if (home && (p === home || p.startsWith(`${home}/`))) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

export function thinkingColor(level: string): ThemeColor {
  switch (level) {
    case "off":
      return "thinkingOff";
    case "minimal":
      return "thinkingMinimal";
    case "low":
      return "thinkingLow";
    case "medium":
      return "thinkingMedium";
    case "high":
      return "thinkingHigh";
    case "xhigh":
      return "thinkingXhigh";
    default:
      return "thinkingOff";
  }
}

export function contextUsageColor(pct: number, expert: number, warning: number): ThemeColor {
  if (pct <= expert) return "success";
  if (pct <= warning) return "warning";
  return "error";
}

/**
 * Apply a caller-provided colorizer one character at a time.
 *
 * The default is deliberately unstyled: this helper must never emit raw ANSI
 * sequences because the TUI theme owns terminal styling.
 */
export function rainbowText(
  text: string,
  colorize?: (character: string, index: number) => string,
): string {
  if (!colorize) return text;
  return Array.from(text, (character, index) => colorize(character, index)).join("");
}
