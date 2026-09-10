/**
 * Compatibility bridge for pi-multi-opencode-go.
 *
 * The companion extension predates a shared runtime service and communicates
 * through these process-local globals. Keep the protocol in one typed module,
 * validate every value at the boundary, and only clear callbacks we own.
 */

interface OpencodeGoGlobals {
  __opencode_go_active_label?: unknown;
  __opencode_go_all_exhausted?: unknown;
  __opencode_go_earliest_reset?: unknown;
  __opencode_go_trigger_refresh?: unknown;
}

function globals(): typeof globalThis & OpencodeGoGlobals {
  return globalThis as typeof globalThis & OpencodeGoGlobals;
}

export interface OpencodeGoQuotaState {
  activeLabel?: string;
  allExhausted: boolean;
  earliestReset?: number;
}

export function readOpencodeGoQuotaState(): OpencodeGoQuotaState {
  const g = globals();
  const activeLabel = typeof g.__opencode_go_active_label === "string"
    ? g.__opencode_go_active_label
    : undefined;
  const earliestReset = typeof g.__opencode_go_earliest_reset === "number" &&
      Number.isFinite(g.__opencode_go_earliest_reset)
    ? g.__opencode_go_earliest_reset
    : undefined;
  return {
    activeLabel,
    allExhausted: g.__opencode_go_all_exhausted === true,
    earliestReset,
  };
}

export function registerOpencodeGoRefresh(refresh: () => void): () => void {
  const g = globals();
  g.__opencode_go_trigger_refresh = refresh;
  return () => {
    if (g.__opencode_go_trigger_refresh === refresh) {
      delete g.__opencode_go_trigger_refresh;
    }
  };
}
