import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authenticatedUsageProviders,
  resolveExtraUsageProviders,
  visibleExtraUsage,
} from "../lib/quota-provider.ts";

test("extra usage providers resolve aliases and report canonical keys", () => {
  assert.deepEqual(resolveExtraUsageProviders("mistral", "openai-codex"), ["mistral"]);
  // le-chat is the same account as mistral, so it must not appear twice.
  assert.deepEqual(resolveExtraUsageProviders("mistral,le-chat", "codex"), ["mistral"]);
  assert.deepEqual(resolveExtraUsageProviders("anthropic", "codex"), ["claude"]);
});

test("extra usage providers skip the active provider and unusable entries", () => {
  // The active provider's own snapshot is rendered first; a duplicate would
  // render the same allowance twice.
  assert.deepEqual(resolveExtraUsageProviders("mistral,codex", "openai-codex"), ["mistral"]);
  assert.deepEqual(resolveExtraUsageProviders(" mistral , , mistral ", null), ["mistral"]);
  assert.deepEqual(resolveExtraUsageProviders("   ", "codex"), []);
});

test("unknown provider ids are kept so the fetcher can report the failure", () => {
  // Dropping unknown ids silently would hide a typo in the env var; the fetcher
  // answers "unknown-provider" and the footer shows that.
  assert.deepEqual(resolveExtraUsageProviders("not-a-provider", "codex"), ["not-a-provider"]);
});

test("the default is the selected model's provider and nothing else", () => {
  // The footer's contract: the meter of the provider the session is running on.
  // A detected provider must not appear just because a credential exists.
  assert.deepEqual(resolveExtraUsageProviders(undefined, "codex", ["mistral", "copilot"]), []);
  assert.deepEqual(resolveExtraUsageProviders("", "codex", ["mistral"]), []);
  assert.deepEqual(resolveExtraUsageProviders("none", "codex", ["mistral"]), []);
  assert.deepEqual(resolveExtraUsageProviders("NONE", "codex", ["mistral"]), []);
});

test("auto adds every authenticated provider, minus the active one", () => {
  assert.deepEqual(resolveExtraUsageProviders("auto", "codex", ["mistral", "copilot"]), [
    "mistral",
    "copilot",
  ]);
  assert.deepEqual(resolveExtraUsageProviders("AUTO", "openai-codex", ["codex", "mistral"]), [
    "mistral",
  ]);
  assert.deepEqual(resolveExtraUsageProviders("all", "codex", ["mistral"]), ["mistral"]);
  assert.deepEqual(resolveExtraUsageProviders("auto", "codex", []), []);
});

test("an explicit list overrides auto detection", () => {
  assert.deepEqual(resolveExtraUsageProviders("mistral", "codex", ["copilot"]), ["mistral"]);
});

test("authenticated providers come from pi auth-store keys, not from trust", () => {
  const auth = {
    "openai-codex": { type: "oauth", access: "a-token", refresh: "a-refresh" },
    mistral: { type: "api", key: "a-key" },
    "github-copilot": { type: "oauth", access: "c-token" },
    // pi-side providers the fetcher cannot answer for are ignored.
    "llama.cpp": { type: "api", key: "local" },
    "quota-status": { "opencode-go": {} },
    // An entry with no usable secret must not produce a bar that always errors.
    kimi: { type: "api", key: "" },
  };
  assert.deepEqual(authenticatedUsageProviders(auth), ["codex", "mistral", "copilot"]);
  // Env-style indirection is resolved, so an unset variable is not a credential.
  assert.deepEqual(authenticatedUsageProviders({ mistral: { key: "$MISSING_TOKEN" } }), []);
  assert.deepEqual(authenticatedUsageProviders({}), []);
});

test("automatic extras that fail are dropped, explicit ones keep their error", () => {
  const ok = { provider: "mistral", windows: [], fetchedAt: 1 };
  const failed = { provider: "copilot", windows: [], error: "HTTP 401", fetchedAt: 1 };
  // A guessed provider that cannot fetch must not add an error bar...
  assert.deepEqual(visibleExtraUsage([ok, failed], false), [ok]);
  // ...but a configured one must say why it is empty.
  assert.deepEqual(visibleExtraUsage([ok, failed], true), [ok, failed]);
});
