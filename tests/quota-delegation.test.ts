import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectProvider,
  fetchProviderUsage,
  fetchQuota,
} from "../lib/quota-provider.ts";

test("detectProvider maps aliases and canonical names via delegation", () => {
  assert.equal(detectProvider("anthropic"), "claude");
  assert.equal(detectProvider("claude-bridge"), "claude");
  assert.equal(detectProvider("claude"), "claude");
  assert.equal(detectProvider("openai-codex"), "codex");
  assert.equal(detectProvider("codex"), "codex");
  assert.equal(detectProvider("opencode"), "opencode-go");
  assert.equal(detectProvider("opencode-go"), "opencode-go");
  assert.equal(detectProvider("cline-pass"), "cline-pass");
  assert.equal(detectProvider("clinepass"), "cline-pass");
  assert.equal(detectProvider("umans"), "umans");
  assert.equal(detectProvider("github-copilot"), "copilot");
  assert.equal(detectProvider("copilot"), "copilot");
  assert.equal(detectProvider("google-gemini-cli"), "gemini");
  assert.equal(detectProvider("gemini"), "gemini");
  assert.equal(detectProvider("kimi-coding"), "kimi");
  assert.equal(detectProvider("kimi"), "kimi");
  assert.equal(detectProvider("cursor"), "cursor");
  assert.equal(detectProvider("commandcode"), "commandcode");
  assert.equal(detectProvider("openference"), "openference");
  assert.equal(detectProvider("unknown-provider"), null);
  assert.equal(detectProvider(""), null);
});

test("fetchQuota delegates Claude usage fetching to shared package", async () => {
  const resetTime = new Date(Date.now() + 3600_000).toISOString();
  const mockFetch: typeof fetch = async (input, init) => {
    assert.match(String(input), /api\.anthropic\.com\/api\/oauth\/usage/);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer claude-test-token");
    return Response.json({
      five_hour: { utilization: 0.45, resets_at: resetTime },
      seven_day: { utilization: 0.20, resets_at: resetTime },
      monthly: { utilization: 0.10, resets_at: resetTime },
    });
  };

  const snapshot = await fetchQuota("anthropic", {
    apiKey: "claude-test-token",
    fetchImpl: mockFetch,
  });

  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "Claude");
  assert.equal(snapshot!.windows.length, 3);
  assert.equal(snapshot!.windows[0]!.label, "5h");
  assert.equal(snapshot!.windows[0]!.usedPercent, 45);
  assert.equal(snapshot!.windows[1]!.label, "Week");
  assert.equal(snapshot!.windows[1]!.usedPercent, 20);
  assert.equal(snapshot!.windows[2]!.label, "Month");
  assert.equal(snapshot!.windows[2]!.usedPercent, 10);
});

test("fetchQuota delegates Codex usage fetching to shared package", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    assert.match(String(input), /chatgpt\.com\/backend-api\/wham\/usage/);
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers?.Authorization, "Bearer codex-test-token");
    return Response.json({
      rate_limit: {
        primary_window: { used_percent: 55, reset_after_seconds: 3600 },
        secondary_window: { used_percent: 20, reset_after_seconds: 86400 },
      },
    });
  };

  const snapshot = await fetchQuota("openai-codex", {
    apiKey: "codex-test-token",
    fetchImpl: mockFetch,
  });

  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "Codex");
  assert.equal(snapshot!.windows.length, 2);
  assert.equal(snapshot!.windows[0]!.label, "5h");
  assert.equal(snapshot!.windows[0]!.usedPercent, 55);
  assert.equal(snapshot!.windows[1]!.label, "Week");
  assert.equal(snapshot!.windows[1]!.usedPercent, 20);
});

test("fetchQuota delegates Umans usage fetching to shared package", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /api\.code\.umans\.ai\/v1\/usage/);
    return Response.json({
      limits: {
        requests: { limit: 1000 },
        concurrency: { limit: 10 },
      },
      usage: {
        requests_in_window: 250,
        concurrent_sessions: 2,
      },
    });
  };

  const snapshot = await fetchQuota("umans", {
    apiKey: "umans-test-token",
    fetchImpl: mockFetch,
  });

  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "Umans");
  assert.equal(snapshot!.windows.length, 2);
  assert.equal(snapshot!.windows[0]!.label, "Req");
  assert.equal(snapshot!.windows[0]!.usedPercent, 25);
  assert.equal(snapshot!.windows[1]!.label, "Conc");
  assert.equal(snapshot!.windows[1]!.usedPercent, 20);
});

test("fetchQuota delegates Copilot usage fetching to shared package", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /api\.github\.com\/copilot_internal\/user/);
    return Response.json({
      quota_reset_date_utc: new Date(Date.now() + 3600_000).toISOString(),
      quota_snapshots: {
        premium_interactions: { percent_remaining: 75 },
        chat: { percent_remaining: 50, unlimited: false },
      },
    });
  };

  const snapshot = await fetchQuota("github-copilot", {
    apiKey: "copilot-test-token",
    fetchImpl: mockFetch,
  });

  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "Copilot");
  assert.equal(snapshot!.windows.length, 2);
  assert.equal(snapshot!.windows[0]!.label, "Premium");
  assert.equal(snapshot!.windows[0]!.usedPercent, 25);
  assert.equal(snapshot!.windows[1]!.label, "Chat");
  assert.equal(snapshot!.windows[1]!.usedPercent, 50);
});

test("fetchQuota delegates Gemini usage fetching to shared package", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /cloudcode-pa\.googleapis\.com/);
    return Response.json({
      buckets: [
        { modelId: "gemini-1.5-pro", remainingFraction: 0.6, resetTime: new Date(Date.now() + 3600_000).toISOString() },
      ],
    });
  };

  const snapshot = await fetchQuota("google-gemini-cli", {
    apiKey: "gemini-test-token",
    fetchImpl: mockFetch,
  });

  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "Gemini");
  assert.equal(snapshot!.windows.length, 1);
  assert.equal(snapshot!.windows[0]!.label, "Pro");
  assert.equal(Math.round(snapshot!.windows[0]!.usedPercent), 40);
});

test("fetchQuota delegates Kimi Coding usage fetching to shared package", async () => {
  const mockFetch: typeof fetch = async (input) => {
    assert.match(String(input), /api\.kimi\.com\/coding\/v1\/usages/);
    return Response.json({
      limits: [
        {
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: 100, remaining: 40, resetTime: new Date(Date.now() + 3600_000).toISOString() },
        },
      ],
    });
  };

  const snapshot = await fetchQuota("kimi-coding", {
    apiKey: "kimi-test-token",
    fetchImpl: mockFetch,
  });

  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "Kimi Coding");
  assert.equal(snapshot!.windows[0]!.label, "5h");
  assert.equal(snapshot!.windows[0]!.usedPercent, 60);
});

test("fetchQuota returns null for unknown provider", async () => {
  const snapshot = await fetchQuota("non-existent-provider");
  assert.equal(snapshot, null);
});

test("fetchProviderUsage is re-exported from lib/quota-provider", async () => {
  assert.equal(typeof fetchProviderUsage, "function");
});
