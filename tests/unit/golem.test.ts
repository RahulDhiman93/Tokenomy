import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGolemSessionContext,
  buildGolemTurnReminder,
  estimateGolemSavingsTokens,
} from "../../src/rules/golem.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { Config, GolemConfig } from "../../src/core/types.js";

const cfgWithGolem = (patch: Partial<GolemConfig>): Config => {
  const clone = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;
  clone.golem = { ...clone.golem, ...patch };
  return clone;
};

test("golem: disabled → buildGolemSessionContext returns null", () => {
  const cfg = cfgWithGolem({ enabled: false });
  assert.equal(buildGolemSessionContext(cfg), null);
  assert.equal(buildGolemTurnReminder(cfg), null);
});

test("golem: lite mode session context contains lite rules, no ultra-mode rules", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "lite" });
  const ctx = buildGolemSessionContext(cfg);
  assert.ok(ctx, "expected session context");
  assert.match(ctx!, /LITE mode/);
  assert.match(ctx!, /Drop hedging/);
  assert.doesNotMatch(ctx!, /Maximum 3 non-code lines/);
});

test("golem: full mode session context adds declarative-sentence rule", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "full" });
  const ctx = buildGolemSessionContext(cfg);
  assert.match(ctx!, /FULL mode/);
  assert.match(ctx!, /Use declarative sentences/);
  assert.match(ctx!, /Drop hedging/); // still inherits lite rules
  assert.doesNotMatch(ctx!, /Maximum 3 non-code lines/);
});

test("golem: ultra mode session context adds max-3-lines rule", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "ultra" });
  const ctx = buildGolemSessionContext(cfg);
  assert.match(ctx!, /ULTRA mode/);
  assert.match(ctx!, /Maximum 3 non-code lines/);
  assert.match(ctx!, /Use declarative sentences/); // inherits full
  assert.match(ctx!, /Drop hedging/); // inherits lite
});

test("golem: safety_gates on → context mentions preserve-in-full block", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "full", safety_gates: true });
  const ctx = buildGolemSessionContext(cfg);
  assert.match(ctx!, /ALWAYS PRESERVE IN FULL/);
  assert.match(ctx!, /Fenced code blocks/);
  assert.match(ctx!, /Shell commands/);
  assert.match(ctx!, /Destructive-action language/);
});

test("golem: safety_gates off → preserve block is omitted", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "full", safety_gates: false });
  const ctx = buildGolemSessionContext(cfg);
  assert.doesNotMatch(ctx!, /ALWAYS PRESERVE IN FULL/);
});

test("golem: turn reminder is short (<200 chars) to keep per-turn overhead minimal", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "full" });
  const reminder = buildGolemTurnReminder(cfg);
  assert.ok(reminder);
  assert.ok(
    reminder!.length < 200,
    `turn reminder too long: ${reminder!.length} chars (${reminder})`,
  );
});

test("golem: turn reminder still mentions safety invariants (code/commands preservation)", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "ultra" });
  const reminder = buildGolemTurnReminder(cfg);
  assert.match(reminder!, /code/i);
});

test("golem: savings estimate is higher for ultra than lite (tighter rules → more savings)", () => {
  const lite = estimateGolemSavingsTokens("lite");
  const full = estimateGolemSavingsTokens("full");
  const ultra = estimateGolemSavingsTokens("ultra");
  const grunt = estimateGolemSavingsTokens("grunt");
  assert.ok(lite < full, `expected lite (${lite}) < full (${full})`);
  assert.ok(full < ultra, `expected full (${full}) < ultra (${ultra})`);
  assert.ok(ultra < grunt, `expected ultra (${ultra}) < grunt (${grunt})`);
});

test("golem: grunt mode inherits all ultra rules AND adds article/pronoun drops", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "grunt" });
  const ctx = buildGolemSessionContext(cfg);
  assert.ok(ctx);
  assert.match(ctx!, /GRUNT mode/);
  // Inherits lite/full/ultra rules.
  assert.match(ctx!, /Drop hedging/);
  assert.match(ctx!, /Use declarative sentences/);
  assert.match(ctx!, /Maximum 3 non-code lines/);
  // Grunt-specific rules.
  assert.match(ctx!, /Drop articles/);
  assert.match(ctx!, /Drop subject pronouns/);
  assert.match(ctx!, /Fragments over complete sentences/);
  assert.match(ctx!, /playful terseness/);
});

test("golem: grunt mode still preserves numbers/names/paths/warnings verbatim", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "grunt" });
  const ctx = buildGolemSessionContext(cfg);
  assert.match(ctx!, /Never sacrifice a number, name, path, or warning/);
});

test("golem: session context includes the opt-out command so users can find the off switch", () => {
  const cfg = cfgWithGolem({ enabled: true, mode: "full" });
  const ctx = buildGolemSessionContext(cfg);
  assert.match(ctx!, /tokenomy golem disable/);
});
