import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fmtTokens, shortenPath } from "../lib/footer-engine/format.js";
import { defaultAssembler } from "../lib/footer-engine/layout.js";
import { builtinRenderers } from "../lib/footer-engine/segments.js";
import { createDefaultSettings, setZone, updateSetting, validateSettings } from "../lib/settings/domain.js";
import { createFileBackend } from "../lib/storage/file-backend.js";
import { createMemoryBackend } from "../lib/storage/memory-backend.js";
import {
  parseOpenCodeGoDashboard,
  resolveAuthValue,
  clampPercent,
  normalizePercent,
  formatResetTime,
  safeError,
} from "../lib/quota-provider.js";

test("fmtTokens handles invalid and negative values", () => {
  assert.equal(fmtTokens(Number.NaN), "0");
  assert.equal(fmtTokens(-1_250), "-1.3k");
  assert.equal(fmtTokens(1_250_000), "1.25M");
});

test("shortenPath does not rewrite a sibling path", () => {
  const home = process.env.HOME ?? "";
  if (!home) return;
  assert.equal(shortenPath(`${home}work`), `${home}work`);
  assert.equal(shortenPath(`${home}/project`), "~/project");
});

test("settings reject invalid zones and persist context dependencies", () => {
  const config = setZone({
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
      usageBars: true,
    },
    contextZones: { expert: 70, warning: 85 },
  }, "expert", Number.NaN);
  assert.equal(config.contextZones.expert, 70);

  const result = updateSetting(config, "contextUsage", "false");
  assert.equal(result.config.segments.contextProgress, false);
  assert.equal(result.config.segments.contextPercentage, false);
  assert.equal(result.config.segments.contextNumbers, false);
});

test("memory storage serializes concurrent mutations and supports zero trimming", async () => {
  const backend = createMemoryBackend();
  await Promise.all([
    backend.append("history.jsonl", "one"),
    backend.append("history.jsonl", "two"),
    backend.append("history.jsonl", "three"),
  ]);
  const lines = await backend.readLines("history.jsonl");
  assert.equal(lines.length, 3);
  await backend.trimLines("history.jsonl", 0);
  assert.deepEqual(await backend.readLines("history.jsonl"), []);
});

test("file storage preserves concurrent appends and zero trimming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-obs-test-"));
  try {
    const first = createFileBackend({ dir });
    const second = createFileBackend({ dir });
    await Promise.all([
      first.append("history.jsonl", "one"),
      second.append("history.jsonl", "two"),
      first.append("history.jsonl", "three"),
    ]);
    assert.equal((await first.readLines("history.jsonl")).length, 3);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "history.jsonl"))).mode & 0o777, 0o600);
    await second.trimLines("history.jsonl", 0);
    assert.deepEqual(await first.readLines("history.jsonl"), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file storage rejects names that escape its directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-obs-test-"));
  try {
    const backend = createFileBackend({ dir });
    await assert.rejects(backend.write("../outside", "nope"), /Invalid storage file name/);
    await assert.rejects(backend.append("nested/history.jsonl", "nope"), /Invalid storage file name/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quota parser accepts both dashboard field orders", () => {
  const parsed = parseOpenCodeGoDashboard(
    "rollingUsage:$R[0]={usagePercent:12.5,resetInSec:60} weeklyUsage:$R[1]={resetInSec:120,usagePercent:25} monthlyUsage:$R[2]={usagePercent:1,resetInSec:3600}",
  );
  assert.deepEqual(parsed.rolling, { usagePercent: 12.5, resetInSec: 60 });
  assert.deepEqual(parsed.weekly, { usagePercent: 25, resetInSec: 120 });
  assert.deepEqual(parsed.monthly, { usagePercent: 1, resetInSec: 3600 });
});

test("quota footer keeps low-usage and monthly windows visible", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const rendered = builtinRenderers.usageBars!({
    theme,
    quotaUsage: {
      provider: "test",
      fetchedAt: Date.now(),
      windows: [
        { label: "5h", usedPercent: 0, resetsIn: "5h" },
        { label: "Month", usedPercent: 50, resetsIn: "20d" },
      ],
    },
  } as never);
  assert.match(rendered, /5h/);
  assert.match(rendered, /Month/);
  // Reset indicator — shown only when usedPercent > 30
  assert.doesNotMatch(rendered, /↻5h/);
  assert.match(rendered, /↻ 20d/);
});

test("live footer speed defaults to updates per second when no token data available", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const rendered = builtinRenderers.tps!({
    isStreaming: true,
    currentTurnStartTime: Date.now() - 1000,
    currentTurnUpdateCount: 2,
    currentTurnOutputTokens: 0,
    lastTurnTps: 0,
    theme,
  } as never);
  assert.match(rendered, /upd\/s$/);
});

test("live tps measures from first token, not turn start", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  // Generation started 0.5s ago, though the turn began 5s ago (TTFT/prefill).
  const rendered = builtinRenderers.tps!({
    isStreaming: true,
    currentTurnStartTime: Date.now() - 5000,
    currentTurnFirstTokenTime: Date.now() - 500,
    currentTurnUpdateCount: 10,
    currentTurnOutputTokens: 50,
    lastTurnTps: 0,
    theme,
  } as never);
  assert.match(rendered, /tok\/s$/);
  // 50 tokens over 0.5s ≈ 100 tok/s, not ~10 tok/s over the full turn.
  assert.match(rendered, /100 tok/);
});

test("live tps falls back to turn start before the first token", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  // No currentTurnFirstTokenTime yet: measure from turn start.
  const rendered = builtinRenderers.tps!({
    isStreaming: true,
    currentTurnStartTime: Date.now() - 1000,
    currentTurnFirstTokenTime: null,
    currentTurnUpdateCount: 2,
    currentTurnOutputTokens: 50,
    lastTurnTps: 0,
    theme,
  } as never);
  assert.match(rendered, /50 tok\/s$/);
});

test("live tps uses output token rate when available", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const rendered = builtinRenderers.tps!({
    isStreaming: true,
    currentTurnStartTime: Date.now() - 1000,
    currentTurnUpdateCount: 10,
    currentTurnOutputTokens: 50,
    lastTurnTps: 0,
    theme,
  } as never);
  assert.match(rendered, /tok\/s$/);
});

test("cache segment shows hit percentage and hides when zero", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const withHit = builtinRenderers.cache!({
    totalCacheRead: 700,
    totalOutputTokens: 300,
    theme,
  } as never);
  assert.match(withHit, /cache 70%/);

  const noHit = builtinRenderers.cache!({
    totalCacheRead: 0,
    totalOutputTokens: 100,
    theme,
  } as never);
  assert.equal(noHit, "");
});

test("turn counter shows current turn number", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const rendered = builtinRenderers.turnCount!({ turnNumber: 12, theme } as never);
  assert.match(rendered, /#12/);
});

test("provider segment shows the provider name and hides when unknown", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const shown = builtinRenderers.provider!({ provider: "commandcode", theme } as never);
  assert.equal(shown, "commandcode");
  const hidden = builtinRenderers.provider!({ provider: null, theme } as never);
  assert.equal(hidden, "");
});

test("provider renders on the accounting line next to cost", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const segs = {
    modelThink: "claude-sonnet-4-6:med",
    runtime: "0:05",
    cost: "$0.04",
    provider: "commandcode",
  } as never;
  const lines = defaultAssembler(segs, 100, theme as never);
  assert.match(lines[1]!, /\$0\.04.*commandcode/);
});

test("narrow screens drop turn counter and tps before the context gauge", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const segs = {
    turnCount: "#3",
    modelThink: "claude-sonnet-4-6:med",
    tps: "⚡12 tok/s",
    contextUsage: "c▮▮▮ 42%",
  } as never;
  const mobile = defaultAssembler(segs, 40, theme as never);
  assert.match(mobile[0]!, /claude-sonnet-4-6/);
  assert.match(mobile[0]!, /42%/);
  assert.doesNotMatch(mobile[0]!, /#3/);
  assert.doesNotMatch(mobile[0]!, /tok\/s/);
});

test("very narrow screens shrink the model but keep the context gauge", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const segs = {
    modelThink: "claude-sonnet-4-6:med",
    contextUsage: "c▮▮▮ 42%",
  } as never;
  const tiny = defaultAssembler(segs, 20, theme as never);
  assert.match(tiny[0]!, /42%/); // gauge survives
  assert.doesNotMatch(tiny[0]!, /claude-sonnet-4-6/); // model shrunk
});

test("accounting line keeps cost and provider on narrow screens", () => {
  const theme = { fg: (_color: string, text: string) => text } as never;
  const segs = {
    runtime: "0:05",
    pwd: "dotfiles",
    git: "main",
    tokens: "↑1.2k ↓3.4k",
    cache: "cache 70%",
    cost: "$0.04",
    provider: "commandcode",
  } as never;
  const mobile = defaultAssembler(segs, 40, theme as never);
  assert.match(mobile[1]!, /\$0\.04/);
  assert.match(mobile[1]!, /commandcode/);
  assert.doesNotMatch(mobile[1]!, /dotfiles/); // pwd dropped
});

/* ───── resolveAuthValue ───── */

test("resolveAuthValue rejects execution-prefixed (!) credentials", () => {
  // Values beginning with `!` are intentionally ignored so this package
  // never executes credential values from auth.json.
  assert.equal(resolveAuthValue("!./fetch-token.sh"), undefined);
  assert.equal(resolveAuthValue("!"), undefined);
});

test("resolveAuthValue resolves env-var indirection and unset ALL_CAPS to undefined", () => {
  const previous = process.env.TEST_QUOTA_KEY;
  process.env.TEST_QUOTA_KEY = "secret-value";
  try {
    assert.equal(resolveAuthValue("TEST_QUOTA_KEY"), "secret-value");
    // A bare ALL_CAPS reference to an unset variable is unavailable (undefined),
    // never a literal token.
    assert.equal(resolveAuthValue("UNSET_TEST_VAR_XYZ"), undefined);
  } finally {
    if (previous === undefined) delete process.env.TEST_QUOTA_KEY;
    else process.env.TEST_QUOTA_KEY = previous;
  }
});

test("resolveAuthValue resolves $VAR and ${VAR} syntax", () => {
  process.env.TEST_QUOTA_TOKEN = "tok-123";
  try {
    assert.equal(resolveAuthValue("$TEST_QUOTA_TOKEN"), "tok-123");
    assert.equal(resolveAuthValue("${TEST_QUOTA_TOKEN}"), "tok-123");
    assert.equal(resolveAuthValue("$UNSET_TOKEN_XYZ"), undefined);
  } finally {
    delete process.env.TEST_QUOTA_TOKEN;
  }
});

test("resolveAuthValue passes through literals and $$/$! escapes", () => {
  assert.equal(resolveAuthValue("sk-literal-key"), "sk-literal-key");
  assert.equal(resolveAuthValue("$$LITERAL"), "$LITERAL");
  assert.equal(resolveAuthValue("$!LITERAL"), "!LITERAL");
  assert.equal(resolveAuthValue("  "), undefined);
  assert.equal(resolveAuthValue(123 as never), undefined);
});

/* ───── percent helpers ───── */

test("clampPercent clamps to [0,100] and coerces non-finite to bounds", () => {
  assert.equal(clampPercent(50), 50);
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent(Infinity), 100);
  assert.equal(clampPercent(-Infinity), 0);
});

test("normalizePercent scales 0..1 fractions to percentages", () => {
  assert.equal(normalizePercent(0.5), 50);
  assert.equal(normalizePercent(1), 100);
  assert.equal(normalizePercent(0), 0);
  assert.equal(normalizePercent(75), 75);
  assert.equal(normalizePercent(150), 100);
  assert.equal(normalizePercent(Number.NaN), 0);
});

/* ───── formatResetTime ───── */

test("formatResetTime renders past, minutes, hours, and days", () => {
  const now = Date.now();
  // Add a small slack to future boundaries so a few ms of Date.now() drift
  // between the snapshot and formatResetTime's internal call can't drop the
  // floor into the previous bucket (a 1ms-boundary flake).
  assert.equal(formatResetTime(new Date(now - 1000)), "now");
  assert.equal(formatResetTime(new Date(now + 5 * 60_000 + 30_000)), "5m");
  assert.equal(formatResetTime(new Date(now + 90 * 60_000 + 30_000)), "1h30m");
  assert.equal(formatResetTime(new Date(now + 5 * 3_600_000 + 30_000)), "5h");
  assert.equal(formatResetTime(new Date(now + 26 * 3_600_000 + 30_000)), "1d2h");
  assert.equal(formatResetTime(new Date(now + 48 * 3_600_000 + 30_000)), "2d");
});

/* ───── safeError ───── */

test("safeError maps HTTP errors, aborts, and unknowns", () => {
  assert.equal(safeError(new Error("HTTP 429")), "HTTP 429");
  assert.equal(safeError(new Error("HTTP 500")), "HTTP 500");
  assert.equal(safeError(new DOMException("aborted", "AbortError")), "timeout");
  assert.equal(safeError(new Error("network reset")), "unavailable");
  assert.equal(safeError(new TypeError("boom")), "unavailable");
  assert.equal(safeError("string error"), "unavailable");
});

/* ───── setZone invariant ───── */

test("setZone enforces expert <= warning", () => {
  const base = createDefaultSettings();
  // Setting expert above warning pulls warning up to match.
  let cfg = setZone(base, "expert", 95);
  assert.equal(cfg.contextZones.expert, 95);
  assert.equal(cfg.contextZones.warning, 95, "warning bumped to match expert");

  // Setting warning below expert pulls expert down to match.
  cfg = setZone(base, "warning", 50);
  assert.equal(cfg.contextZones.warning, 50);
  assert.equal(cfg.contextZones.expert, 50, "expert dropped to match warning");

  // Normal case leaves both independent.
  cfg = setZone(base, "expert", 65);
  assert.equal(cfg.contextZones.expert, 65);
  assert.equal(cfg.contextZones.warning, 85);
});

test("setZone clamps out-of-range values", () => {
  const base = createDefaultSettings();
  assert.equal(setZone(base, "expert", 150).contextZones.expert, 100);
  assert.equal(setZone(base, "expert", -10).contextZones.expert, 0);
  // NaN is ignored, keeps previous value
  assert.equal(setZone(base, "expert", Number.NaN).contextZones.expert, 70);
});

/* ───── validateSettings ───── */

test("validateSettings rejects unknown presets and falls back to standard", () => {
  const cfg = validateSettings({
    version: 1,
    preset: "nonexistent",
    segments: { modelThink: true },
    contextZones: { expert: 70, warning: 85 },
  });
  assert.equal(cfg.preset, "standard");
});
