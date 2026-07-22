import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { LayoutAssembler } from "./types.js";

export const defaultAssembler: LayoutAssembler = (segments, width, theme) => {
  const sep = " " + theme.fg("dim", "▸") + " ";

  function padLine(text: string): string {
    const w = visibleWidth(text);
    if (w < width) return text + " ".repeat(width - w);
    return text;
  }

  // Line 1 — current generation state
  const line1 = [
    segments["turnCount"],
    segments["modelThink"],
    segments["tps"],
    segments["contextUsage"],
  ].filter(Boolean).join(sep);
  // Line 2 — session / accounting
  const line2 = [
    segments["runtime"],
    segments["pwd"],
    segments["git"],
    segments["tokens"],
    segments["cache"],
    segments["cost"],
  ].filter(Boolean).join(sep);
  // Line 3 — quota bars only (separate line so it doesn't crowd accounting)
  const line3 = segments["usageBars"] || "";

  const twoLine = [
    visibleWidth(line1) > width ? truncateToWidth(line1, width) : padLine(line1),
    visibleWidth(line2) > width ? truncateToWidth(line2, width) : padLine(line2),
  ].filter((line) => visibleWidth(line) > 0);

  const hasBars = visibleWidth(line3) > 0;

  if (visibleWidth(line1) <= width && visibleWidth(line2) <= width) {
    return hasBars
      ? [...twoLine, truncateToWidth(line3, width)]
      : twoLine;
  }

  // Narrow fallback: split accounting across two lines
  //   [1] # + model + tps + ctx
  //   [2] runtime + pwd + git
  //   [3] tokens + cache + cost
  //   [4] usageBars  (if present)
  const l1 = [
    segments["turnCount"],
    segments["modelThink"],
    segments["tps"],
    segments["contextUsage"],
  ].filter(Boolean).join(sep);
  const l2 = [segments["runtime"], segments["pwd"], segments["git"]]
    .filter(Boolean).join(sep);
  const l3 = [
    segments["tokens"],
    segments["cache"],
    segments["cost"],
  ].filter(Boolean).join(sep);

  const narrow = [
    visibleWidth(l1) > width ? truncateToWidth(l1, width) : padLine(l1),
    visibleWidth(l2) > width ? truncateToWidth(l2, width) : padLine(l2),
    visibleWidth(l3) > width ? truncateToWidth(l3, width) : padLine(l3),
  ].filter((line) => visibleWidth(line) > 0);

  return hasBars
    ? [...narrow, truncateToWidth(line3, width)]
    : narrow;
};
