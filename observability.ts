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
 *   /footer                 - Interactive footer action menu
 *   /footer menu            - Interactive footer action menu
 *   /footer toggle          - Toggle the observability footer on/off
 *   /footer path            - Toggle folder name/full path
 *   /footer settings        - Open footer settings

 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  SettingsList,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import {
  createDefaultSettings,
  loadSettings,
  saveSettings,
  updateSetting,
  toSettingsListItems,
  type SettingsConfig,
} from "./lib/settings/index.js";

import { renderFooter, type FooterInput } from "./lib/footer-engine/index.js";

import { createFileStorage, getDefaultObservabilityDir, type Storage } from "./lib/storage/index.js";
import { fetchQuota, type QuotaSnapshot } from "./lib/quota-provider.ts";
import { registerOpencodeGoRefresh } from "./lib/opencode-go-integration.ts";

/* ───── Types ───── */

interface TurnRecord {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  durationMs: number;
  tps: number;
  model: string;
}

interface SessionState {
  startTime: number;
  /** Turns completed during this extension session only. */
  turns: TurnRecord[];
  currentTurnStartTime: number | null;
  currentTurnFirstTokenTime: number | null;
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
  settings: SettingsConfig;
  quotaUsage: QuotaSnapshot | null;
}

interface ModelRegistryLike {
  getApiKeyForProvider?(provider: string): Promise<unknown> | unknown;
}

/* ───── Helpers ───── */

function getStringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const prop = (value as Record<string, unknown>)[key];
  return typeof prop === "string" ? prop : undefined;
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

/* ───── Extension ───── */

export default function (pi: ExtensionAPI) {
  const storage: Storage = createFileStorage({
    dir: getDefaultObservabilityDir(),
  });

  let quotaEpoch = 0;
  let requestFooterRender = () => {};

  const state: SessionState = {
    startTime: Date.now(),
    turns: [],
    currentTurnStartTime: null,
    currentTurnFirstTokenTime: null,
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
    quotaUsage: null,
    settings: createDefaultSettings(),
  };

  async function refreshQuota(ctx: ExtensionContext): Promise<void> {
    const provider = ctx.model?.provider;
    const epoch = ++quotaEpoch;
    // Keep the previous snapshot visible while the new one is in flight so a
    // periodic refresh doesn't blank the bars; the epoch guard below ensures a
    // stale fetch can't overwrite a newer one.
    if (!provider) {
      state.quotaUsage = null;
      requestFooterRender();
      return;
    }

    let apiKey: string | undefined;
    if (provider === "cline-pass" || provider === "umans" || provider === "openference") {
      try {
        const registry = (ctx as ExtensionContext & { modelRegistry?: ModelRegistryLike }).modelRegistry;
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

  /* ─── Lifecycle ─── */

  pi.on("session_start", async (_event, ctx) => {
    state.startTime = Date.now();
    state.turns = [];
    state.currentTurnStartTime = null;
    state.currentTurnFirstTokenTime = null;
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
    const envPath = process.env.PI_OBS_SHOW_FULL_PATH?.trim().toLowerCase();
    if (envPath === "1" || envPath === "true") {
      state.settings = { ...state.settings, showFullPath: true };
    }

    if (state.footerEnabled && ctx.mode === "tui") {
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
    state.currentTurnFirstTokenTime = null;
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
    // Record the first streaming update as the generation start. Measuring from
    // here (rather than turn_start) excludes TTFT, prefill, and thinking time,
    // so the reported tok/s reflects actual generation speed.
    if (state.currentTurnFirstTokenTime === null) {
      state.currentTurnFirstTokenTime = Date.now();
    }
    state.currentTurnUpdateCount++;

    // Track actual output token count during streaming for live tok/s.
    // The event may carry partial usage from the accumulating assistant message.
    const msg = event.message as AssistantMessage | undefined;
    if (msg?.usage?.output !== undefined && Number.isFinite(msg.usage.output)) {
      state.currentTurnOutputTokens = Math.max(
        state.currentTurnOutputTokens,
        msg.usage.output,
      );
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    const turnDuration = state.currentTurnStartTime ? Date.now() - state.currentTurnStartTime : 0;
    // Generation duration: first streaming token → turn end. Falls back to the
    // full turn duration when no tokens streamed (e.g. tool-only turn).
    const genDuration = state.currentTurnFirstTokenTime
      ? Date.now() - state.currentTurnFirstTokenTime
      : turnDuration;

    let inputTokens = 0;
    let outputTokens = 0;
    let cost = 0;

    const completedMessage = event.message as AssistantMessage | undefined;
    if (completedMessage?.role !== "assistant" || !completedMessage.usage) {
      state.isStreaming = false;
      state.currentTurnStartTime = null;
      state.currentTurnFirstTokenTime = null;
      state.currentTurnUpdateCount = 0;
      state.currentTurnOutputTokens = 0;
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
    const safeTurnDuration = Number.isFinite(turnDuration) ? Math.max(0, turnDuration) : 0;
    const safeGenDuration = Number.isFinite(genDuration) ? Math.max(0, genDuration) : 0;
    // tok/s reflects generation speed (first token → end), not wall-clock
    // turn time, so it isn't dragged down by TTFT/prefill/thinking.
    const tps = safeGenDuration > 0 ? safeOutputTokens / (safeGenDuration / 1000) : 0;

    const record: TurnRecord = {
      inputTokens: safeInputTokens,
      outputTokens: safeOutputTokens,
      cost: safeCost,
      durationMs: safeTurnDuration,
      tps,
      model: ctx.model?.id ?? completedMessage?.model ?? "unknown",
    };

    state.turns.push(record);
    state.isStreaming = false;
    state.currentTurnStartTime = null;
    state.currentTurnFirstTokenTime = null;
    state.currentTurnUpdateCount = 0;

  });

  pi.on("agent_end", async (event, ctx) => {
    state.isStreaming = false;

    if (ctx.mode !== "tui" || state.agentStartTime === null) {
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
      `Run throughput ${tokensPerSecond.toFixed(1)} tok/s. out ${output.toLocaleString()}, in ${input.toLocaleString()}, cache r/w ${cacheRead.toLocaleString()}/${cacheWrite.toLocaleString()}, total ${totalTokens.toLocaleString()}, ${elapsedSeconds.toFixed(1)}s`,
      "info",
    );
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode === "tui") teardownFooter(ctx);
  });

  /* ─── Footer ─── */

  function setupFooter(ctx: ExtensionContext) {
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      // Register re-fetch callback for failover account rotation.
      const unregisterQuotaRefresh = registerOpencodeGoRefresh(() => {
        void refreshQuota(ctx).finally(() => tui.requestRender());
      });
      let diffAdded = 0;
      let diffRemoved = 0;
      let gitDirty = false;

      let diffRefreshInFlight = false;
      async function refreshDiff() {
        if (diffRefreshInFlight) return;
        diffRefreshInFlight = true;
        try {
          const [diffResult, statusResult] = await Promise.all([
            pi.exec("git", ["diff", "HEAD", "--numstat"], { cwd: ctx.cwd }),
            pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
              cwd: ctx.cwd,
            }),
          ]);
          let added = 0;
          let removed = 0;
          if (diffResult.code === 0 && diffResult.stdout) {
            for (const line of diffResult.stdout.split("\n")) {
              const parts = line.trim().split(/\s+/);
              if (parts.length >= 2) {
                const a = parseInt(parts[0], 10);
                const b = parseInt(parts[1], 10);
                if (Number.isFinite(a)) added += a;
                if (Number.isFinite(b)) removed += b;
              }
            }
          }
          diffAdded = added;
          diffRemoved = removed;
          gitDirty = statusResult.code === 0 && statusResult.stdout.trim().length > 0;
        } catch {
          diffAdded = 0;
          diffRemoved = 0;
          gitDirty = false;
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
      }, 5_000);

      // Periodic quota refresh every 5 minutes (fetchQuota handles its own cache)
      const quotaTimer = setInterval(() => {
        void refreshQuota(ctx).finally(() => tui.requestRender());
      }, 5 * 60 * 1000);

      return {
        dispose() {
          unregisterQuotaRefresh();
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
            provider: ctx.model?.provider ?? null,
            thinkingLevel: pi.getThinkingLevel(),
            runtimeMs: Date.now() - state.startTime,
            isStreaming: state.isStreaming,
            currentTurnStartTime: state.currentTurnStartTime,
            currentTurnFirstTokenTime: state.currentTurnFirstTokenTime,
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
            showFullPath: state.settings.showFullPath === true,
            gitBranch: footerData.getGitBranch(),
            gitDirty,
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

  const footerMenuOptions = [
    "Toggle footer",
    "Toggle path display",
    "Open settings",
  ];

  async function handleFooter(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const action = args.trim().toLowerCase();
    if (!action || action === "menu") {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Footer menu requires interactive mode", "error");
        return;
      }
      const choice = await ctx.ui.select("Footer", footerMenuOptions);
      switch (choice) {
        case "Toggle footer":
          await handleToggle("", ctx);
          break;
        case "Toggle path display":
          await handleTogglePath("", ctx);
          break;
        case "Open settings":
          await handleSettings("", ctx);
          break;
      }
      return;
    }

    switch (action) {
      case "toggle":
        await handleToggle("", ctx);
        return;
      case "path":
        await handleTogglePath("", ctx);
        return;
      case "settings":
        await handleSettings("", ctx);
        return;
      default:
        ctx.ui.notify("Usage: /footer [menu|toggle|path|settings]", "error");
    }
  }

  async function handleToggle(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui") return;
      state.footerEnabled = !state.footerEnabled;
      if (state.footerEnabled) {
        setupFooter(ctx);
        ctx.ui.notify("Observability footer enabled", "info");
      } else {
        teardownFooter(ctx);
        ctx.ui.notify("Observability footer disabled", "info");
      }
  }

  async function handleTogglePath(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui") return;
      state.settings = {
        ...state.settings,
        showFullPath: state.settings.showFullPath !== true,
      };
      try {
        await saveSettings(state.settings, storage);
      } catch {
        ctx.ui.notify("Could not save footer path setting", "warning");
      }
      const mode = state.settings.showFullPath ? "full path" : "folder name";
      ctx.ui.notify(`Footer path: ${mode}`, "info");
  }

  async function handleSettings(_args: string, ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui") {
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
  }

  pi.registerCommand("footer", {
    description: "Footer actions: menu, toggle, path, settings",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trim().toLowerCase();
      const options = ["menu", "toggle", "path", "settings"];
      return options
        .filter((option) => option.startsWith(value))
        .map((option) => ({ value: option, label: option }));
    },
    handler: handleFooter,
  });
}
