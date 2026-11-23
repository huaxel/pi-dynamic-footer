import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveExtraUsageProviders } from "../lib/quota-provider.ts";

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
  assert.deepEqual(resolveExtraUsageProviders("", "codex"), []);
  assert.deepEqual(resolveExtraUsageProviders(undefined, "codex"), []);
  assert.deepEqual(resolveExtraUsageProviders("   ", "codex"), []);
});

test("unknown provider ids are kept so the fetcher can report the failure", () => {
  // Dropping unknown ids silently would hide a typo in the env var; the fetcher
  // answers "unknown-provider" and the footer shows that.
  assert.deepEqual(resolveExtraUsageProviders("not-a-provider", "codex"), ["not-a-provider"]);
});
