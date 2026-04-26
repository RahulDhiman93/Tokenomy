import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import {
  buildGolemSessionContext,
  buildGolemTurnReminder,
  estimateGolemSavingsTokens,
  resolveGolemMode,
} from "../../src/rules/golem.js";

const reconCfg = () => ({
  ...DEFAULT_CONFIG,
  golem: { ...DEFAULT_CONFIG.golem, enabled: true, mode: "recon" as const },
});

test("resolveGolemMode: passes through 'recon'", () => {
  assert.equal(resolveGolemMode(reconCfg()), "recon");
});

test("buildGolemSessionContext (recon): includes recon-specific rules + safety gates", () => {
  const ctx = buildGolemSessionContext(reconCfg());
  assert.ok(ctx, "context expected when enabled");
  // Mode label.
  assert.match(ctx!, /tokenomy-golem: RECON/);
  // recon-specific rule: filler-word stripping.
  assert.match(ctx!, /Strip filler words/);
  // recon-specific rule: status-report shape.
  assert.match(ctx!, /Status reports as: <verb> <object> <result>/);
  // recon overrides grunt's playful allowance.
  assert.match(ctx!, /Strip the dry-humor allowance/);
  // recon includes all earlier rules — drop-articles is grunt-level.
  assert.match(ctx!, /Drop articles/);
  // Safety gates always preserved.
  assert.match(ctx!, /ALWAYS PRESERVE IN FULL/);
  assert.match(ctx!, /Numerical results, counts, measurements/);
});

test("buildGolemTurnReminder (recon): mode label appears", () => {
  const reminder = buildGolemTurnReminder(reconCfg());
  assert.ok(reminder);
  assert.match(reminder!, /tokenomy-golem: RECON/);
});

test("estimateGolemSavingsTokens: recon > grunt > ultra > full > lite", () => {
  const lite = estimateGolemSavingsTokens("lite");
  const full = estimateGolemSavingsTokens("full");
  const ultra = estimateGolemSavingsTokens("ultra");
  const grunt = estimateGolemSavingsTokens("grunt");
  const recon = estimateGolemSavingsTokens("recon");
  assert.ok(lite < full, `expected lite < full (${lite} < ${full})`);
  assert.ok(full < ultra, `expected full < ultra (${full} < ${ultra})`);
  assert.ok(ultra < grunt, `expected ultra < grunt (${ultra} < ${grunt})`);
  assert.ok(grunt < recon, `expected grunt < recon (${grunt} < ${recon})`);
});

test("buildGolemSessionContext: mode-switcher hint mentions recon", () => {
  const ctx = buildGolemSessionContext(reconCfg());
  assert.ok(ctx);
  assert.match(ctx!, /lite\|full\|ultra\|grunt\|recon\|auto/);
});
