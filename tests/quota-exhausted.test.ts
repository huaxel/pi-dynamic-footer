// Tests for the all-exhausted Cooldown display in the opencode-go quota
// snapshot: when the failover extension reports every account on cooldown,
// fetchQuota("opencode-go") surfaces a full Cooldown window with the earliest
// reset countdown and a distinct provider label.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { fetchQuota } from "../lib/quota-provider.ts";

const FIXTURE_USAGE = () => ({
  usage: {
    rolling: { status: "ok", percent: 42.5, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
    weekly: { status: "ok", percent: 10, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
    monthly: { status: "ok", percent: 5, resetsAt: new Date(Date.now() + 2_592_000_000).toISOString() },
  },
});

const AUTH_FIXTURE = {
  "opencode-go-failover": {
    accounts: [
      { key: "k1", label: "sub-1" },
      { key: "k2", label: "sub-2" },
    ],
  },
};

let tmpDir: string;
let savedAgentDir: string | undefined;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "footer-quota-test-"));
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpDir;
  await writeFile(
    join(tmpDir, "auth.json"),
    JSON.stringify(AUTH_FIXTURE),
    "utf-8",
  );
  (globalThis as Record<string, unknown>).fetch = async (
    input: string | URL | Request,
  ) => {
    const url = String(input);
    if (url.includes("/zen/go/v1/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => FIXTURE_USAGE(),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
});

after(async () => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  delete (globalThis as Record<string, unknown>).fetch;
  const g = globalThis as Record<string, unknown>;
  delete g.__opencode_go_active_label;
  delete g.__opencode_go_all_exhausted;
  delete g.__opencode_go_earliest_reset;
  await rm(tmpDir, { recursive: true, force: true });
});

function setGlobals(overrides: Record<string, unknown>) {
  const g = globalThis as Record<string, unknown>;
  delete g.__opencode_go_active_label;
  delete g.__opencode_go_all_exhausted;
  delete g.__opencode_go_earliest_reset;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete g[key];
    else g[key] = value;
  }
}

test("normal state: active account label and no cooldown window", async () => {
  setGlobals({ __opencode_go_active_label: "sub-1" });
  const snapshot = await fetchQuota("opencode-go");
  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "opencode-go (sub-1)");
  assert.equal(snapshot!.windows.length, 3);
  assert.ok(!snapshot!.windows.some((w) => w.label === "Cooldown"));
});

test("all exhausted: provider label + full cooldown window with reset countdown", async () => {
  const earliest = Date.now() + 7_200_000; // 2h away
  setGlobals({
    __opencode_go_active_label: "sub-1",
    __opencode_go_all_exhausted: true,
    __opencode_go_earliest_reset: earliest,
  });
  const snapshot = await fetchQuota("opencode-go");
  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "opencode-go (all exhausted)");
  assert.equal(snapshot!.windows.length, 4);
  const cooldown = snapshot!.windows.find((w) => w.label === "Cooldown");
  assert.ok(cooldown, "cooldown window present");
  assert.equal(cooldown!.usedPercent, 100);
  assert.ok(cooldown!.resetsIn, "reset countdown shown");
});

test("all exhausted without earliest reset: no cooldown window, label only", async () => {
  setGlobals({
    __opencode_go_active_label: "sub-2",
    __opencode_go_all_exhausted: true,
  });
  const snapshot = await fetchQuota("opencode-go");
  assert.ok(snapshot);
  assert.equal(snapshot!.provider, "opencode-go (all exhausted)");
  assert.ok(!snapshot!.windows.some((w) => w.label === "Cooldown"));
});
