import assert from "node:assert/strict";
import { test } from "node:test";

import { detectProvider, fetchQuota } from "../lib/quota-provider.ts";

const RESET = new Date(Date.now() + 3_600_000).toISOString();

test("detectProvider maps Openference", () => {
  assert.equal(detectProvider("openference"), "openference");
});

test("fetchQuota Openference parses the authenticated usage endpoint", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /api\.openference\.com\/v1\/usage/);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer sk-test");
    return Response.json({
      usage: {
        window: { used: 400, limit: 800, resets_at: RESET },
        weekly: { percent: 10 },
      },
    });
  };

  try {
    const snapshot = await fetchQuota("openference", { apiKey: "sk-test" });
    assert.ok(snapshot);
    assert.equal(snapshot!.provider, "Openference");
    assert.deepEqual(snapshot!.windows.map((window) => window.label), ["5h", "Week"]);
    assert.equal(snapshot!.windows[0]!.usedPercent, 50);
    assert.equal(snapshot!.windows[1]!.usedPercent, 10);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("fetchQuota Openference shows exhausted windows from a 402 response", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    error: "Request limit exceeded",
    type: "insufficient_quota",
    code: "window_quota_exceeded",
    resets_at: RESET,
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
