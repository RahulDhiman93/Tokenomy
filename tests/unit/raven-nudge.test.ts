import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { buildRavenSessionContext, buildRavenTurnReminder } from "../../src/raven/nudge.js";

test("raven nudge: disabled config is silent", () => {
  const cfg = { ...DEFAULT_CONFIG, raven: { ...DEFAULT_CONFIG.raven, enabled: false } };
  assert.equal(buildRavenSessionContext(cfg), null);
  assert.equal(buildRavenTurnReminder("review this change", cfg), null);
});

test("raven nudge: enabled config injects Claude-first session guidance", () => {
  const cfg = { ...DEFAULT_CONFIG, raven: { ...DEFAULT_CONFIG.raven, enabled: true } };
  const context = buildRavenSessionContext(cfg);
  assert.ok(context);
  assert.match(context!, /Raven bridge enabled/);
  assert.match(context!, /Claude Code remains the primary agent/);
  assert.match(context!, /mcp__tokenomy-graph__create_handoff_packet/);
});

test("raven nudge: review prompts get a per-turn reminder", () => {
  const cfg = { ...DEFAULT_CONFIG, raven: { ...DEFAULT_CONFIG.raven, enabled: true } };
  const reminder = buildRavenTurnReminder("Can you review this before I merge?", cfg);
  assert.ok(reminder);
  assert.match(reminder!, /Raven bridge/);
  assert.match(reminder!, /create_handoff_packet/);
});

test("raven nudge: unrelated prompts stay quiet", () => {
  const cfg = { ...DEFAULT_CONFIG, raven: { ...DEFAULT_CONFIG.raven, enabled: true } };
  assert.equal(buildRavenTurnReminder("thanks", cfg), null);
});
