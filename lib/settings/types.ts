export type SegmentKey =
  | "modelThink"
  | "provider"
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

export type PresetName = "minimal" | "standard" | "verbose" | "performance";

export interface SettingsConfig {
  version: number;
  preset: PresetName;
  segments: Record<SegmentKey, boolean>;
  contextZones: { expert: number; warning: number };
  /** Show the abbreviated home-relative full path instead of the basename. */
  showFullPath?: boolean;
}

export interface SettingsListItem {
  id: string;
  label: string;
  description: string;
  currentValue: string;
  values: string[];
}

export interface SettingsUpdateResult {
  config: SettingsConfig;
  derivedUpdates: Array<{ id: string; value: string }>;
}

export interface SegmentMetadata {
  id: SegmentKey;
  label: string;
  description: string;
}
