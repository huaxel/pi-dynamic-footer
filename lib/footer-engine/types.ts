import type { ContextUsage, Theme as PiTheme } from "@earendil-works/pi-coding-agent";

import type { QuotaSnapshot } from "../quota-provider.ts";
import type { SegmentKey, SettingsConfig } from "../settings/types.js";

export type { SegmentKey } from "../settings/types.js";

export type FooterSettings = Pick<SettingsConfig, "segments" | "contextZones">;

export interface FooterInput {
  model: string;
  /** Provider name from ctx.model.provider, null when unknown */
  provider: string | null;
  thinkingLevel: string;
  runtimeMs: number;
  isStreaming: boolean;
  currentTurnStartTime: number | null;
  currentTurnFirstTokenTime: number | null;
  currentTurnUpdateCount: number;
  lastTurnTps: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  totalCacheRead: number;
  currentTurnOutputTokens: number;
  turnNumber: number;
  fastModeSupported: boolean;
  fastModeEnabled: boolean;
  serviceTier: string | null;
  contextUsage: ContextUsage | null;
  cwd: string;
  showFullPath: boolean;
  gitBranch: string | null;
  /** True when git reports any tracked or untracked working-tree change. */
  gitDirty?: boolean;
  gitDiffAdded: number;
  gitDiffRemoved: number;
  settings: FooterSettings;
  theme: PiTheme;
  /** Subscription usage bars data, fetched on session_start and periodically */
  quotaUsage: QuotaSnapshot | null;
}

export interface SegmentRenderer {
  (input: FooterInput): string;
}

export interface LayoutAssembler {
  (segments: Record<string, string>, width: number, theme: PiTheme): string[];
}

export interface FooterEngineOptions {
  segments?: Partial<Record<SegmentKey, SegmentRenderer>>;
  layout?: LayoutAssembler;
}
