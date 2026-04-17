import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldApply, estimateTokens } from "../../src/core/gate.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";

test("gate: passthrough when savings negative or zero", () => {
  assert.equal(shouldApply(1000, 1000, DEFAULT_CONFIG), false);
  assert.equal(shouldApply(1000, 1500, DEFAULT_CONFIG), false);
});

test("gate: always trim huge input even if small savings", () => {
  const cfg = { ...DEFAULT_CONFIG, gate: { ...DEFAULT_CONFIG.gate, always_trim_above_bytes: 40_000 } };
  assert.equal(shouldApply(100_000, 99_900, cfg), true);
});

test("gate: rejects tiny savings below min_saved_bytes", () => {
  const cfg = { ...DEFAULT_CONFIG, gate: { always_trim_above_bytes: 1_000_000, min_saved_bytes: 4_000, min_saved_pct: 0.1 } };
  assert.equal(shouldApply(10_000, 9_000, cfg), false);
});

test("gate: requires min_saved_pct when below always_trim_above_bytes", () => {
  const cfg = { ...DEFAULT_CONFIG, gate: { always_trim_above_bytes: 1_000_000, min_saved_bytes: 1_000, min_saved_pct: 0.25 } };
  assert.equal(shouldApply(10_000, 8_500, cfg), false);
  assert.equal(shouldApply(10_000, 7_000, cfg), true);
});

test("estimateTokens: bytes/4 ceiling", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
});
