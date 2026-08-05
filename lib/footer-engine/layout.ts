import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { LayoutAssembler } from "./types.js";

/**
 * Display order and drop priority for the status line (line 1).
 * rank 0 = never dropped; higher rank = dropped later (more important).
 */
const STATUS_SPEC = [
  { key: "turnCount", rank: 1 },
  { key: "modelThink", rank: 0 },
  { key: "tps", rank: 2 },
  { key: "contextUsage", rank: 0 },
] as const;

/** Display order and drop priority for the accounting line (line 2). */
const ACCOUNTING_SPEC = [
  { key: "runtime", rank: 1 },
  { key: "pwd", rank: 2 },
  { key: "git", rank: 0 },
  { key: "tokens", rank: 3 },
  { key: "cache", rank: 4 },
  { key: "cost", rank: 0 },
  { key: "provider", rank: 0 },
] as const;

interface LinePart {
  key: string;
  text: string;
}

/**
 * Join a line's segments in display order, guaranteeing the result fits
 * `width`. When it overflows, the least important segments (rank > 0, lowest
 * rank first) are dropped instead of being cut mid-text; rank 0 segments are
 * always kept. As a last resort the model is shrunk so the context gauge stays
 * visible, otherwise the line is right-truncated.
 */
function assembleLine(
  segments: Record<string, string>,
  spec: ReadonlyArray<{ key: string; rank: number }>,
  sep: string,
  width: number,
): string {
  const rankOf = (key: string) => spec.find((s) => s.key === key)!.rank;
  const parts: LinePart[] = spec
    .filter((s) => segments[s.key])
    .map((s) => ({ key: s.key, text: segments[s.key]! }));
  if (parts.length === 0) return "";
  const join = (list: LinePart[]) => list.map((p) => p.text).join(sep);

  let selected = parts.slice();
  while (visibleWidth(join(selected)) > width) {
    let dropIdx = -1;
    let lowest = Number.POSITIVE_INFINITY;
    selected.forEach((p, i) => {
      const rank = rankOf(p.key);
      if (rank > 0 && rank < lowest) {
        lowest = rank;
        dropIdx = i;
      }
    });
    if (dropIdx < 0) break;
    selected.splice(dropIdx, 1);
  }

  const line = join(selected);
  if (visibleWidth(line) <= width) return line;

  // Last resort: keep the context gauge visible by shrinking the model.
  const model = selected.find((p) => p.key === "modelThink")?.text;
  const gauge = selected.find((p) => p.key === "contextUsage")?.text;
  if (model && gauge) {
    const budget = width - visibleWidth(gauge) - visibleWidth(sep);
    if (budget > 0) return truncateToWidth(model, budget) + sep + gauge;
  }
  return truncateToWidth(line, width);
}

export const defaultAssembler: LayoutAssembler = (segments, width, theme) => {
  const sep = " " + theme.fg("dim", "▸") + " ";

  function padLine(text: string): string {
    const w = visibleWidth(text);
    if (w < width) return text + " ".repeat(width - w);
    return text;
  }

  // Line 1 — current generation state (context gauge + model always survive)
  const line1 = assembleLine(segments, STATUS_SPEC, sep, width);
  // Line 2 — session / accounting (git, cost + provider always survive)
  const line2 = assembleLine(segments, ACCOUNTING_SPEC, sep, width);
  // Line 3 — quota bars only (separate line so it doesn't crowd accounting)
  const line3 = segments["usageBars"] || "";

  const lines = [padLine(line1), padLine(line2)].filter(
    (line) => visibleWidth(line) > 0,
  );
  return visibleWidth(line3) > 0 ? [...lines, truncateToWidth(line3, width)] : lines;
};
