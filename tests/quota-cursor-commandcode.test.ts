import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { detectProvider, fetchQuota } from "../lib/quota-provider.ts";
import {
  buildCommandCodeWindows,
  fetchCommandCodeUsage,
  fetchCursorUsage,
  parseCommandCodeCredits,
  parseCommandCodeSubscription,
  resolveCommandCodeCookieHeader,
  resolveCursorCookieHeader,
  cursorCookieFromAccessToken,
  parseCursorUsageSummary,
} from "@juanbenjumea/opencode-go-usage";

let tmpDir: string;
let savedAgentDir: string | undefined;
let savedFetch: typeof globalThis.fetch | undefined;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "footer-quota-cc-test-"));
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  savedFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = tmpDir;
});

after(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  if (savedFetch) globalThis.fetch = savedFetch;
  else delete (globalThis as Record<string, unknown>).fetch;
  await rm(tmpDir, { recursive: true, force: true });
});

test("detectProvider maps cursor and commandcode", () => {
  assert.equal(detectProvider("cursor"), "cursor");
  assert.equal(detectProvider("commandcode"), "commandcode");
});

test("parseCursorUsageSummary keeps fractional percent units", () => {
  const windows = parseCursorUsageSummary({
    billingCycleEnd: "2026-06-01T00:00:00.000Z",
    individualUsage: {
      plan: {
        totalPercentUsed: 0.40625,
        autoPercentUsed: 0.36,
        apiPercentUsed: 12.5,
      },
    },
  });
  assert.equal(windows[0]!.label, "Plan");
  assert.equal(windows[0]!.usedPercent, 0.40625);
  assert.equal(windows[1]!.label, "Auto");
  assert.equal(windows[1]!.usedPercent, 0.36);
  assert.equal(windows[2]!.label, "API");
  assert.equal(windows[2]!.usedPercent, 12.5);
});

test("parseCommandCodeCredits reads rolling windows and monthly remaining", () => {
  const credits = parseCommandCodeCredits({
    credits: { monthlyCredits: 8.5 },
    windowLimits: {
      fiveHour: { cap: 3, used: 0.75, resetAt: 1_780_000_000_000 },
      weekly: { cap: 15, used: 1.5, resetAt: 1_780_100_000_000 },
    },
  });
  assert.equal(credits.monthlyRemaining, 8.5);
  assert.equal(credits.fiveHour?.usedPercent, 25);
  assert.equal(credits.weekly?.usedPercent, 10);
});

test("buildCommandCodeWindows adds monthly usage from plan catalog", () => {
  const credits = parseCommandCodeCredits({
    credits: { monthlyCredits: 8.7784 },
  });
  const subscription = parseCommandCodeSubscription({
    success: true,
    data: {
      planId: "individual-go",
      currentPeriodEnd: "2026-06-06T07:28:50.000Z",
    },
  });
  const windows = buildCommandCodeWindows(credits, subscription);
  assert.equal(windows.length, 1);
  assert.equal(windows[0]!.label, "Month");
  assert.ok(windows[0]!.usedPercent > 10 && windows[0]!.usedPercent < 15);
});

test("cursorCookieFromAccessToken builds Workos session cookie", () => {
  const header = Buffer.from(JSON.stringify({ sub: "user|abc123", exp: 4_000_000_000 })).toString("base64url");
  const token = `eyJhbGciOiJIUzI1NiJ9.${header}.sig`;
  assert.equal(
    cursorCookieFromAccessToken(token),
    "WorkosCursorSessionToken=abc123%3A%3A" + token,
  );
});

test("fetchQuota commandcode uses configured session cookie", async () => {
  await writeFile(
    join(tmpDir, "quota-sessions.json"),
    JSON.stringify({
      commandcode: {
        cookie: "__Secure-better-auth.session_token=session-token-value",
      },
    }),
    "utf-8",
  );

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const cookie = headers?.Cookie ?? "";
    assert.match(cookie, /session-token-value/);
    if (url.includes("/internal/billing/credits")) {
      return Response.json({
        credits: { monthlyCredits: 5 },
        windowLimits: { fiveHour: { cap: 2, used: 1, resetAt: 1_780_000_000_000 } },
      });
    }
    if (url.includes("/internal/billing/subscriptions")) {
      return Response.json({ success: true, data: null });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const snapshot = await fetchQuota("commandcode");
  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "CommandCode");
  assert.equal(snapshot!.windows[0]!.label, "5h");
  assert.equal(snapshot!.windows[0]!.usedPercent, 50);
});

test("resolveCursorCookieHeader prefers quota-sessions.json", async () => {
  await writeFile(
    join(tmpDir, "quota-sessions.json"),
    JSON.stringify({ cursor: { cookie: "WorkosCursorSessionToken=from-sessions" } }),
    "utf-8",
  );
  await writeFile(
    join(tmpDir, "auth.json"),
    JSON.stringify({ cursor: { cookie: "WorkosCursorSessionToken=from-auth" } }),
    "utf-8",
  );
  assert.equal(resolveCursorCookieHeader(), "WorkosCursorSessionToken=from-sessions");
});

test("resolveCursorCookieHeader falls back to auth.json cookie", async () => {
  await writeFile(join(tmpDir, "quota-sessions.json"), "{}", "utf-8");
  await writeFile(
    join(tmpDir, "auth.json"),
    JSON.stringify({ cursor: { cookie: "WorkosCursorSessionToken=test" } }),
    "utf-8",
  );
  assert.equal(resolveCursorCookieHeader(), "WorkosCursorSessionToken=test");
});

test("fetchQuota cursor parses usage-summary response", async () => {
  await writeFile(
    join(tmpDir, "quota-sessions.json"),
    JSON.stringify({ cursor: { cookie: "WorkosCursorSessionToken=test" } }),
    "utf-8",
  );

  globalThis.fetch = async (input) => {
    const url = String(input);
    assert.match(url, /cursor\.com\/api\/usage-summary/);
    return Response.json({
      billingCycleEnd: "2026-06-01T00:00:00.000Z",
      individualUsage: {
        plan: {
          totalPercentUsed: 30,
          autoPercentUsed: 12,
          apiPercentUsed: 18,
        },
      },
    });
  };

  const snapshot = await fetchQuota("cursor");
  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "Cursor");
  assert.deepEqual(
    snapshot!.windows.map((window) => window.label),
    ["Plan", "Auto", "API"],
  );
});
