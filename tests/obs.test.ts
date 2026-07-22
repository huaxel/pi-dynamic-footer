import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fmtTokens, shortenPath } from "../lib/footer-engine/format.js";
import { builtinRenderers } from "../lib/footer-engine/segments.js";
import { setZone, updateSetting } from "../lib/settings/domain.js";
import { createFileBackend } from "../lib/storage/file-backend.js";
import { createMemoryBackend } from "../lib/storage/memory-backend.js";
import { parseOpenCodeGoDashboard } from "../lib/quota-provider.js";

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
