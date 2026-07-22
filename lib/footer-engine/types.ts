import type { ContextUsage, Theme as PiTheme } from "@earendil-works/pi-coding-agent";

import type { QuotaSnapshot } from "../quota-provider.ts";

export type SegmentKey =
  | "modelThink"
  | "runtime"
  | "pwd"
  | "git"
  | "contextUsage"
  | "contextProgress"
  | "contextPercentage"
  | "contextNumbers"
  | "tokens"
  | "tps"
  | "cost"
  | "cache"
  | "turnCount"
  | "usageBars";

export interface FooterSettings {
  segments: Record<SegmentKey, boolean>;
  contextZones: { expert: number; warning: number };
}

export interface FooterInput {
  model: string;
  thinkingLevel: string;
  runtimeMs: number;
  isStreaming: boolean;
  currentTurnStartTime: number | null;
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
