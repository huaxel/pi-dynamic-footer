import assert from "node:assert/strict";
import { test } from "node:test";

import { detectProvider, fetchQuota } from "../lib/quota-provider.ts";

const NOW = Date.parse("2026-08-27T21:00:00.000Z");
const WINDOW_RESET_MS = NOW + 3_600_000; // +1h
const WEEK_RESET_MS = NOW + 86_400_000; // +1d

// Mirrors GET https://openference.com/api/user/me (window 25%, week 50%).
const ME_FIXTURE = {
  usage: { windowQuotaUsed: 200, weekQuotaUsed: 6500, windowRequests: 100, weekRequests: 3000 },
  plan: { name: "Pro", requestsPerWindow: 800, requestsPerWeek: 13000, windowHours: 5 },
  limits: { windowQuotaUsed: 200, weekQuotaUsed: 6500, windowResetAt: WINDOW_RESET_MS, weeklyResetAt: WEEK_RESET_MS },
};

test("detectProvider maps Openference", () => {
  assert.equal(detectProvider("openference"), "openference");
});

test("fetchQuota Openference parses the dashboard profile endpoint", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /openference\.com\/api\/user\/me/);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-test");
    return Response.json(ME_FIXTURE);
  };

  try {
    const snapshot = await fetchQuota("openference", { apiKey: "sk-test" });
    assert.ok(snapshot);
    assert.equal(snapshot!.provider, "Openference");
    assert.deepEqual(snapshot!.windows.map((window) => window.label), ["5h", "Week"]);
    assert.equal(snapshot!.windows[0]!.usedPercent, 25);
    assert.equal(snapshot!.windows[1]!.usedPercent, 50);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("fetchQuota Openference shows exhausted windows from a 402 response", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    error: "Request limit exceeded (800 per 5 hours)",
    type: "insufficient_quota",
    code: "window_quota_exceeded",
    resets_at: new Date(NOW + 3_600_000).toISOString(),
  }, { status: 402 });

  try {
    const snapshot = await fetchQuota("openference", { apiKey: "sk-test-402" });
    assert.ok(snapshot);
    assert.deepEqual(snapshot!.windows.map((window) => window.usedPercent), [100]);
    assert.equal(snapshot!.windows[0]!.label, "5h");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
