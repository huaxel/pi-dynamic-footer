/**
 * Agent Observability Extension
 *
 * Replaces the default footer with a live observability bar showing:
 * - Session input/output tokens & cost
 * - Live TPS during streaming (chunk-based estimate)
 * - Session runtime
 * - Current model, thinking level, fast mode & git branch
 * - Git diff stats (added/removed lines)
 * - Context usage (current/max)
 *
 * It also prints the legacy TPS summary notification at the end of each
 * agent run, so the standalone TPS extension is no longer needed.
 *
 * Commands:
 *   /obs          - Print full observability dashboard + last 10 sessions
 *   /obs-toggle   - Toggle the observability footer on/off
 *   /obs-settings - Open status bar settings (presets, segments, zones)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme as PiTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SettingsList,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
  updateSetting,
  toSettingsListItems,
  type SettingsConfig,
} from "./lib/settings/index.js";

import {
  renderFooter,
  fmtDuration,
  fmtTokens,
  shortenPath,
  type FooterInput,
} from "./lib/footer-engine/index.js";

import { createFileStorage, type Storage } from "./lib/storage/index.js";
import { fetchQuota, type QuotaSnapshot } from "./lib/quota-provider.ts";

/* ───── Types ───── */

interface TurnRecord {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
  tps: number;
  model: string;
}

interface PersistedTurn {
  customType: "obs-turn";
  data: TurnRecord;
}

interface SessionState {
  startTime: number;
  turns: TurnRecord[];
  currentTurnStartTime: number | null;
  currentTurnUpdateCount: number;
  currentTurnOutputTokens: number;
  totalCacheRead: number;
  turnNumber: number;
  agentStartTime: number | null;
  isStreaming: boolean;
  footerEnabled: boolean;
  fastModeSupported: boolean;
  fastModeEnabled: boolean;
  serviceTier: string | null;
  showFullPath: boolean;
  settings: SettingsConfig;
  quotaUsage: QuotaSnapshot | null;
}

interface SessionSummary {
  endedAt: number;
  runtimeMs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  model: string;
  cwd: string;
  branch: string | null;
}

/* ───── Helpers ───── */

function normalizeTurnRecord(value: unknown): TurnRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<TurnRecord>;
  const numbers = [
    record.turnIndex,
    record.inputTokens,
    record.outputTokens,
    record.cost,
    record.durationMs,
    record.tps,
  ];
  if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number))) {
    return null;
  }
  if (typeof record.model !== "string") return null;
  return {
    turnIndex: record.turnIndex!,
    inputTokens: Math.max(0, record.inputTokens!),
    outputTokens: Math.max(0, record.outputTokens!),
    cost: Math.max(0, record.cost!),
    durationMs: Math.max(0, record.durationMs!),
    tps: Math.max(0, record.tps!),
    model: record.model,
  };
}

function scanHistoricalTurns(ctx: ExtensionContext): TurnRecord[] {
  const turns: TurnRecord[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "obs-turn") continue;
    const record = normalizeTurnRecord((entry as unknown as PersistedTurn).data);
    if (record) turns.push(record);
  }
  return turns;
}

function getSessionStartTime(ctx: ExtensionContext): number {
  const entries = ctx.sessionManager.getBranch();
  for (const e of entries) {
    if (typeof e.timestamp === "number" && Number.isFinite(e.timestamp)) {
      return e.timestamp;
    }
  }
  return Date.now();
}

function alignCell(str: string, width: number, align: "left" | "right" = "left"): string {
  const vis = visibleWidth(str);
  if (vis > width) return truncateToWidth(str, width);
  const pad = width - vis;
  return align === "right" ? " ".repeat(pad) + str : str + " ".repeat(pad);
}

function getStringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === "string" ? prop : undefined;
}

function fitColumnWidths(headers: string[], rows: string[][], termWidth: number): number[] {
  const widths = headers.map((header, index) =>
    Math.max(1, visibleWidth(header), ...rows.map((row) => visibleWidth(row[index] ?? ""))),
  );
  const available = Math.max(1, termWidth - 2 - 2 * (widths.length - 1));
  let total = widths.reduce((sum, width) => sum + width, 0);
  while (total > available) {
    let widest = -1;
    for (let i = 0; i < widths.length; i++) {
      if (widths[i]! > 1 && (widest < 0 || widths[i]! > widths[widest]!)) widest = i;
    }
    if (widest < 0) break;
    widths[widest]!--;
    total--;
  }
  return widths;
}

function getServiceTierFromPayload(payload: unknown): string | null {
  const tier = getStringProp(payload, "service_tier") ?? getStringProp(payload, "serviceTier");
  return tier?.trim().toLowerCase() || null;
}

function isFastServiceTier(serviceTier: string | null): boolean {
  // OpenAI's actual fast/priority tier is `priority`. Older/local shims may
  // still emit `fast`, so keep accepting it for backwards-compatible display.
  return serviceTier === "priority" || serviceTier === "fast";
}

function supportsFastMode(ctx: ExtensionContext): boolean {
  const model = ctx.model;
  if (!model) return false;
  if (model.provider !== "openai" && model.provider !== "openai-codex") return false;
  return model.api === "openai-responses" || model.api === "openai-codex-responses";
}

/* ───── Dashboard formatting ───── */

type DashboardTheme = Pick<PiTheme, "fg" | "bold">;

function buildDashboard(
  state: SessionState,
  ctx: ExtensionContext,
  branch: string | null,
  history: SessionSummary[],
  termWidth: number,
  theme: DashboardTheme,
): string[] {
  const runtime = Date.now() - state.startTime;
  const safeTermWidth = Math.max(1, Math.floor(termWidth));
  if (safeTermWidth < 24) {
    return [truncateToWidth("Obs", safeTermWidth)];
  }

  const totalIn = state.turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalOut = state.turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalCost = state.turns.reduce((s, t) => s + t.cost, 0);

  const B = (s: string) => theme.fg("border", s);
  const lines: string[] = [];

  // ── Summary Card ──
  const summaryLines = [
    theme.bold("Agent Observability Dashboard"),
    `Runtime: ${fmtDuration(runtime)}    Dir: ${shortenPath(ctx.cwd)}`,
    branch
      ? `Branch: ${branch}    Model: ${ctx.model?.id ?? "none"}`
      : `Model: ${ctx.model?.id ?? "none"}`,
    state.serviceTier
      ? `Service tier: ${state.serviceTier}${state.fastModeEnabled ? " (fast)" : ""}`
      : `Fast mode: ${state.fastModeSupported ? "available" : "not available"}`,
    `Tokens: ↑${fmtTokens(totalIn)} ↓${fmtTokens(totalOut)}`,
    `Cost: $${totalCost.toFixed(6)}`,
  ];
  const summaryW = Math.max(
    4,
    Math.min(Math.max(...summaryLines.map((c) => visibleWidth(c))) + 4, safeTermWidth),
  );
  const inner = summaryW - 4;
  const padSummary = (text: string) => {
    const safe = truncateToWidth(text, inner);
    const vis = visibleWidth(safe);
    const pad = Math.max(0, inner - vis);
    return B("│ ") + safe + B(`${" ".repeat(pad)} │`);
  };

  lines.push(B(`┌${"─".repeat(summaryW - 2)}┐`));
  lines.push(padSummary(summaryLines[0]));
  lines.push(B(`├${"─".repeat(summaryW - 2)}┤`));
  for (let i = 1; i < summaryLines.length; i++) {
    lines.push(padSummary(summaryLines[i]));
  }
  lines.push(B(`└${"─".repeat(summaryW - 2)}┘`));

  // ── Turns Table ──
  if (state.turns.length > 0) {
    lines.push("");
    lines.push(`  ${theme.bold(theme.fg("accent", `TURNS  (${state.turns.length})`))}`);

    const headers = ["#", "Input", "Output", "Time", "TPS", "Cost", "Model"];
    const rows = state.turns.map((t, i) => [
      `${i + 1}`,
      `↑${fmtTokens(t.inputTokens)}`,
      `↓${fmtTokens(t.outputTokens)}`,
      fmtDuration(t.durationMs),
      `${t.tps.toFixed(1)}`,
      `$${t.cost.toFixed(2)}`,
      t.model,
    ]);

    const colW = fitColumnWidths(headers, rows, safeTermWidth);

    const pad = "  ";
    const hdr = `  ${headers.map((h, i) => alignCell(h, colW[i]!)).join(pad)}`;
    lines.push(theme.fg("dim", hdr));
    lines.push(B(`  ${"─".repeat(visibleWidth(hdr) - 2)}`));
    for (const row of rows) {
      const cells = row.map((c, i) => alignCell(c, colW[i]!, i === 0 || i >= 3 ? "left" : "right"));
      lines.push(`  ${cells.join(pad)}`);
    }
  }

  // ── History Table ──
  if (history.length > 0) {
    lines.push("");
    lines.push(`  ${theme.bold(theme.fg("accent", "LAST 10 SESSIONS"))}`);

    const headers = ["When", "Duration", "Turns", "Input", "Output", "Cost", "Model"];
    const rows = history
      .slice()
      .reverse()
      .map((h) => {
        const date = new Date(h.endedAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return [
          date,
          fmtDuration(h.runtimeMs),
          `${h.turns}`,
          `↑${fmtTokens(h.inputTokens)}`,
          `↓${fmtTokens(h.outputTokens)}`,
          `$${h.cost.toFixed(2)}`,
          h.model,
        ];
      });

    const colW = fitColumnWidths(headers, rows, safeTermWidth);

    const pad = "  ";
    const hdr = `  ${headers.map((h, i) => alignCell(h, colW[i]!)).join(pad)}`;
    lines.push(theme.fg("dim", hdr));
    lines.push(B(`  ${"─".repeat(visibleWidth(hdr) - 2)}`));
    for (const row of rows) {
      const cells = row.map((c, i) => alignCell(c, colW[i]!, i === 0 || i >= 2 ? "left" : "right"));
      lines.push(`  ${cells.join(pad)}`);
    }
  }

  return lines;
}

/* ───── Extension ───── */

export default function (pi: ExtensionAPI) {
  const storage: Storage = createFileStorage({
    dir: join(homedir(), ".pi", "agent", "observability"),
  });

  let quotaEpoch = 0;
  let requestFooterRender = () => {};

  async function refreshQuota(ctx: ExtensionContext): Promise<void> {
    const provider = ctx.model?.provider;
    const epoch = ++quotaEpoch;
    state.quotaUsage = null;
    if (!provider) return;

    let apiKey: string | undefined;
    if (provider === "cline-pass" || provider === "umans") {
      try {
        const registry = (ctx as any).modelRegistry;
        const resolved = await registry?.getApiKeyForProvider?.(provider);
        if (typeof resolved === "string") apiKey = resolved;
      } catch {
        // The fetcher will fall back to environment/auth.json credentials.
      }
    }

    try {
      const snapshot = await fetchQuota(provider, { apiKey });
      if (epoch === quotaEpoch) state.quotaUsage = snapshot;
    } catch {
      if (epoch === quotaEpoch) state.quotaUsage = null;
    } finally {
      requestFooterRender();
    }
  }

  const state: SessionState = {
    startTime: Date.now(),
    turns: [],
    currentTurnStartTime: null,
    currentTurnUpdateCount: 0,
    currentTurnOutputTokens: 0,
    totalCacheRead: 0,
    turnNumber: 0,
    agentStartTime: null,
    isStreaming: false,
    footerEnabled: true,
    fastModeSupported: false,
    fastModeEnabled: false,
    serviceTier: null,
    showFullPath: false,
    quotaUsage: null,
    settings: {
      version: 1,
      preset: "standard",
      segments: {
        modelThink: true,
        runtime: true,
        pwd: true,
        git: true,
        contextUsage: true,
        contextProgress: true,
        contextPercentage: true,
        contextNumbers: true,
        tokens: true,
        tps: true,
        cost: true,
        cache: true,
        turnCount: false,
        usageBars: true,
      },
      contextZones: { expert: 70, warning: 85 },
    },
  };

  /* ─── Lifecycle ─── */

  pi.on("session_start", async (_event, ctx) => {
    state.startTime = getSessionStartTime(ctx);
    state.turns = scanHistoricalTurns(ctx);
    state.currentTurnStartTime = null;
    state.currentTurnUpdateCount = 0;
    state.currentTurnOutputTokens = 0;
    state.totalCacheRead = 0;
    state.turnNumber = 0;
    state.agentStartTime = null;
    state.isStreaming = false;
    state.fastModeSupported = supportsFastMode(ctx);
    state.fastModeEnabled = false;
    state.serviceTier = null;
    try {
      state.settings = await loadSettings(storage);
    } catch {
      state.settings = createDefaultSettings();
      if (ctx.hasUI) ctx.ui.notify("Observability settings unavailable; using defaults", "warning");
    }
    state.quotaUsage = null;

    if (state.footerEnabled && ctx.hasUI) {
      setupFooter(ctx);
    }

    // Fire-and-forget quota fetch on session start
    void refreshQuota(ctx);
  });

  pi.on("agent_start", async () => {
    state.agentStartTime = Date.now();
  });

  pi.on("turn_start", async (_event, _ctx) => {
    state.currentTurnStartTime = Date.now();
    state.currentTurnUpdateCount = 0;
    state.currentTurnOutputTokens = 0;
    state.turnNumber++;
    state.isStreaming = true;
  });

  pi.on("model_select", async (_event, ctx) => {
    state.fastModeSupported = supportsFastMode(ctx);
    state.fastModeEnabled = false;
    state.serviceTier = null;

    // Refresh quota for the newly selected provider
    void refreshQuota(ctx);
  });

  pi.on("before_provider_request", async (event, ctx) => {
    state.serviceTier = getServiceTierFromPayload(event.payload);
    state.fastModeEnabled = isFastServiceTier(state.serviceTier);
    state.fastModeSupported = supportsFastMode(ctx) || state.fastModeEnabled;
  });

  pi.on("message_update", async (event, _ctx) => {
    state.currentTurnUpdateCount++;

    // Track actual output token count during streaming for live tok/s.
    // The event may carry partial usage from the accumulating assistant message.
    const msg = (event as any).message as AssistantMessage | undefined;
    if (msg?.usage?.output !== undefined && Number.isFinite(msg.usage.output)) {
      state.currentTurnOutputTokens = Math.max(
        state.currentTurnOutputTokens,
        msg.usage.output,
      );
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    const duration = state.currentTurnStartTime ? Date.now() - state.currentTurnStartTime : 0;

    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;

    const completedMessage = event.message as AssistantMessage | undefined;
    if (completedMessage?.role !== "assistant" || !completedMessage.usage) {
      state.isStreaming = false;
      state.currentTurnStartTime = null;
      state.currentTurnUpdateCount = 0;
      return;
    }

    inputTokens = completedMessage.usage.input ?? 0;
    outputTokens = completedMessage.usage.output ?? 0;
    cost = completedMessage.usage.cost?.total ?? 0;

    const cacheRead = completedMessage.usage.cacheRead ?? 0;
    const safeCacheRead = Number.isFinite(cacheRead) ? Math.max(0, cacheRead) : 0;
    state.totalCacheRead += safeCacheRead;

    const safeInputTokens = Number.isFinite(inputTokens) ? Math.max(0, inputTokens) : 0;
    const safeOutputTokens = Number.isFinite(outputTokens) ? Math.max(0, outputTokens) : 0;
    const safeCost = Number.isFinite(cost) ? Math.max(0, cost) : 0;
    const safeDuration = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    const tps = safeDuration > 0 ? safeOutputTokens / (safeDuration / 1000) : 0;

    const record: TurnRecord = {
      turnIndex: event.turnIndex,
      inputTokens: safeInputTokens,
      outputTokens: safeOutputTokens,
      cost: safeCost,
      durationMs: safeDuration,
      tps,
      model: ctx.model?.id ?? completedMessage?.model ?? "unknown",
    };

    state.turns.push(record);
    state.isStreaming = false;
    state.currentTurnStartTime = null;
    state.currentTurnUpdateCount = 0;

    pi.appendEntry("obs-turn", record);
  });

  pi.on("agent_end", async (event, ctx) => {
    state.isStreaming = false;

    if (!ctx.hasUI || state.agentStartTime === null) {
      state.agentStartTime = null;
      return;
    }

    const elapsedMs = Date.now() - state.agentStartTime;
    state.agentStartTime = null;
    if (elapsedMs <= 0) return;

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let totalTokens = 0;

    for (const message of event.messages) {
      if (message.role !== "assistant") continue;
      input += message.usage?.input ?? 0;
      output += message.usage?.output ?? 0;
      cacheRead += message.usage?.cacheRead ?? 0;
      cacheWrite += message.usage?.cacheWrite ?? 0;
      totalTokens += message.usage?.totalTokens ?? 0;
    }

    if (output <= 0) return;

    const elapsedSeconds = elapsedMs / 1000;
    const tokensPerSecond = output / elapsedSeconds;
    ctx.ui.notify(
      `TPS ${tokensPerSecond.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`,
      "info",
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) teardownFooter(ctx);

    const totalIn = state.turns.reduce((s, t) => s + t.inputTokens, 0);
    const totalOut = state.turns.reduce((s, t) => s + t.outputTokens, 0);
    const totalCost = state.turns.reduce((s, t) => s + t.cost, 0);
    const runtime = Date.now() - state.startTime;

    let branch: string | null = null;
    try {
      const result = await pi.exec("git", ["branch", "--show-current"], {
        cwd: ctx.cwd,
      });
      branch = result.stdout?.trim() || null;
    } catch {
      branch = null;
    }

    const summary: SessionSummary = {
      endedAt: Date.now(),
      runtimeMs: runtime,
      turns: state.turns.length,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cost: totalCost,
      model: ctx.model?.id ?? "unknown",
      cwd: ctx.cwd,
      branch,
    };

    const historyStore = storage.jsonl<SessionSummary>("history");
    try {
      await historyStore.append(summary);
      await historyStore.trim({ keepLast: 200 });
    } catch {
      if (ctx.hasUI) ctx.ui.notify("Could not save observability session history", "warning");
    }
  });

  /* ─── Footer ─── */

  function setupFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      // Register re-fetch callback for failover account rotation.
      (globalThis as any).__opencode_go_trigger_refresh = () => {
        void refreshQuota(ctx).finally(() => tui.requestRender());
      };
      let diffAdded = 0;
      let diffRemoved = 0;

      let diffRefreshInFlight = false;
      async function refreshDiff() {
        if (diffRefreshInFlight) return;
        diffRefreshInFlight = true;
        try {
          const result = await pi.exec("git", ["diff", "HEAD", "--numstat"], {
            cwd: ctx.cwd,
          });
          if (result.code === 0 && result.stdout) {
            let added = 0;
            let removed = 0;
            for (const line of result.stdout.split("\n")) {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2) {
                const a = parseInt(parts[0], 10);
                const b = parseInt(parts[1], 10);
                if (Number.isFinite(a)) added += a;
                if (Number.isFinite(b)) removed += b;
              }
            }
            diffAdded = added;
            diffRemoved = removed;
          } else {
            diffAdded = 0;
            diffRemoved = 0;
          }
        } catch {
          diffAdded = 0;
          diffRemoved = 0;
        } finally {
          diffRefreshInFlight = false;
          tui.requestRender();
        }
      }

      void refreshDiff();

      const unsubBranch = footerData.onBranchChange(() => {
        void refreshDiff();
      });

      const timer = setInterval(() => {
        void refreshDiff();
      }, 1000);

      // Periodic quota refresh every 5 minutes (fetchQuota handles its own cache)
      const quotaTimer = setInterval(() => {
        void refreshQuota(ctx).finally(() => tui.requestRender());
      }, 5 * 60 * 1000);

      return {
        dispose() {
          (globalThis as any).__opencode_go_trigger_refresh = undefined;
          unsubBranch();
          clearInterval(timer);
          clearInterval(quotaTimer);
          requestFooterRender = () => {};
        },
        invalidate() {},
        render(width: number): string[] {
          let totalIn = 0;
          let totalOut = 0;
          let totalCost = 0;
          for (const t of state.turns) {
            totalIn += t.inputTokens;
            totalOut += t.outputTokens;
            totalCost += t.cost;
          }

          const lastTurnTps = state.turns.length > 0 ? state.turns[state.turns.length - 1]!.tps : 0;

          const input: FooterInput = {
            model: ctx.model?.id ?? "no-model",
            thinkingLevel: pi.getThinkingLevel(),
            runtimeMs: Date.now() - state.startTime,
            isStreaming: state.isStreaming,
            currentTurnStartTime: state.currentTurnStartTime,
            currentTurnUpdateCount: state.currentTurnUpdateCount,
            currentTurnOutputTokens: state.currentTurnOutputTokens,
            totalCacheRead: state.totalCacheRead,
            turnNumber: state.turnNumber,
            lastTurnTps,
            totalInputTokens: totalIn,
            totalOutputTokens: totalOut,
            totalCost,
            fastModeSupported: state.fastModeSupported,
            fastModeEnabled: state.fastModeEnabled,
            serviceTier: state.serviceTier,
            contextUsage: ctx.getContextUsage() ?? null,
            cwd: ctx.cwd,
            showFullPath: state.showFullPath,
            gitBranch: footerData.getGitBranch(),
            gitDiffAdded: diffAdded,
            gitDiffRemoved: diffRemoved,
            settings: state.settings,
            theme,
            quotaUsage: state.quotaUsage,
          };

          const footerLines = renderFooter(input, width);
          const extStatuses = footerData.getExtensionStatuses();
          if (extStatuses.size > 0) {
            const sorted = Array.from(extStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) => text);
            const statusLine = sorted.join(theme.fg("dim", " · "));
            footerLines.push(truncateToWidth(statusLine, width));
          }
          return footerLines;
        },
      };
    });
  }

  function teardownFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter(undefined);
  }

  /* ─── Commands ─── */

  pi.registerCommand("obs", {
    description: "Show observability dashboard (tokens, cost, TPS, runtime, history)",
    handler: async (_args, ctx) => {
      const branchResult = await pi.exec("git", ["branch", "--show-current"], {
        cwd: ctx.cwd,
      });
      const branch = branchResult.stdout?.trim() || null;
      const history = await storage.jsonl<SessionSummary>("history").read();

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        let cachedWidth = 0;
        let cachedLines: string[] = [];

        return {
          invalidate() {
            cachedWidth = 0;
            cachedLines = [];
          },
          handleInput(data: string) {
            if (
              matchesKey(data, Key.escape) ||
              matchesKey(data, Key.enter) ||
              matchesKey(data, Key.space)
            ) {
              done();
            }
          },
          render(width: number): string[] {
            if (cachedWidth === width && cachedLines.length > 0) {
              return cachedLines;
            }

            cachedLines = buildDashboard(state, ctx, branch, history, width, theme);

            // Add hint at bottom
            const hint = theme.fg("dim", "Press ESC or Enter to close");
            const hintVisible = visibleWidth(hint);
            const pad = Math.max(0, width - hintVisible);
            cachedLines.push("");
            cachedLines.push(hint + " ".repeat(pad));

            cachedWidth = width;
            return cachedLines;
          },
        };
      });
    },
  });

  pi.registerCommand("obs-toggle", {
    description: "Toggle the observability footer on/off",
    handler: async (_args, ctx) => {
      state.footerEnabled = !state.footerEnabled;
      if (state.footerEnabled) {
        setupFooter(ctx);
        ctx.ui.notify("Observability footer enabled", "info");
      } else {
        teardownFooter(ctx);
        ctx.ui.notify("Observability footer disabled", "info");
      }
    },
  });

  pi.registerCommand("obs-toggle-path", {
    description: "Toggle between folder name and full path in footer",
    handler: async (_args, ctx) => {
      state.showFullPath = !state.showFullPath;
      const mode = state.showFullPath ? "full path" : "folder name";
      ctx.ui.notify(`Footer path: ${mode}`, "info");
    },
  });

  pi.registerCommand("obs-settings", {
    description: "Open status bar settings (layout presets, segment toggles, context zones)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Settings UI requires interactive mode", "error");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let config = state.settings;

        const settingsListTheme = {
          label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
          value: (text: string, selected: boolean) =>
            selected ? theme.fg("accent", text) : theme.fg("muted", text),
          description: (text: string) => theme.fg("dim", text),
          cursor: theme.fg("accent", "→ "),
          hint: (text: string) => theme.fg("dim", text),
        };

        let settingsList: InstanceType<typeof SettingsList> | null = null;

        function rebuildSettingsList() {
          settingsList = new SettingsList(
            toSettingsListItems(config),
            10,
            settingsListTheme,
            async (id, newValue) => {
              const result = updateSetting(config, id, newValue);
              config = result.config;
              state.settings = config;

              for (const u of result.derivedUpdates) {
                settingsList?.updateValue(u.id, u.value);
              }

              try {
                await saveSettings(config, storage);
              } catch {
                ctx.ui.notify("Could not save observability settings", "warning");
              }
              tui.requestRender();
            },
            done,
          );
        }

        rebuildSettingsList();

        return {
          invalidate() {
            settingsList?.invalidate();
          },
          handleInput(data: string) {
            if (matchesKey(data, Key.escape)) {
              done();
              return;
            }
            settingsList?.handleInput(data);
          },
          render(width: number): string[] {
            if (!settingsList) return [];
            return settingsList.render(width);
          },
        };
      });
    },
  });
}
