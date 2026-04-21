import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../../src/core/config.js";

const withStubHome = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-cfg-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

test("config: defaults when no files exist (conservative aggression ×2)", () => {
  withStubHome((home) => {
    const cfg = loadConfig(home);
    assert.equal(cfg.aggression, DEFAULT_CONFIG.aggression);
    assert.equal(cfg.gate.always_trim_above_bytes, DEFAULT_CONFIG.gate.always_trim_above_bytes * 2);
    assert.equal(cfg.mcp.max_text_bytes, DEFAULT_CONFIG.mcp.max_text_bytes * 2);
    assert.equal(cfg.graph.build_timeout_ms, DEFAULT_CONFIG.graph.build_timeout_ms * 2);
    assert.equal(
      cfg.graph.query_budget_bytes.get_minimal_context,
      DEFAULT_CONFIG.graph.query_budget_bytes.get_minimal_context * 2,
    );
  });
});

test("config: global file controls aggression; project overrides thresholds; aggressive ×0.5", () => {
  withStubHome((home) => {
    mkdirSync(join(home, ".tokenomy"), { recursive: true });
    writeFileSync(
      join(home, ".tokenomy", "config.json"),
      JSON.stringify({ aggression: "aggressive" }),
    );
    const project = join(home, "proj");
    mkdirSync(project);
    writeFileSync(
      join(project, ".tokenomy.json"),
      JSON.stringify({ mcp: { max_text_bytes: 2000, per_block_head: 200, per_block_tail: 100 } }),
    );
    const cfg = loadConfig(project);
    assert.equal(cfg.aggression, "aggressive");
    assert.equal(cfg.mcp.max_text_bytes, 1000);
    assert.equal(cfg.mcp.per_block_head, 100);
    assert.equal(cfg.mcp.per_block_tail, 50);
    // get_review_context default is 4000; aggressive ×0.5 → 2000 (above the
    // Math.max floor of 512 enforced in applyAggression).
    assert.equal(
      cfg.graph.query_budget_bytes.get_review_context,
      Math.round(DEFAULT_CONFIG.graph.query_budget_bytes.get_review_context * 0.5),
    );
  });
});

test("config: malformed JSON falls back to defaults", () => {
  withStubHome((home) => {
    mkdirSync(join(home, ".tokenomy"), { recursive: true });
    writeFileSync(join(home, ".tokenomy", "config.json"), "{ not json");
    const cfg = loadConfig(home);
    assert.equal(cfg.aggression, DEFAULT_CONFIG.aggression);
  });
});

test("config: graph.auto_refresh_on_read defaults to true", () => {
  withStubHome((home) => {
    const cfg = loadConfig(home);
    assert.equal(cfg.graph.auto_refresh_on_read, true);
  });
});

test("config: graph.auto_refresh_on_read can be overridden via ~/.tokenomy/config.json", () => {
  withStubHome((home) => {
    mkdirSync(join(home, ".tokenomy"), { recursive: true });
    writeFileSync(
      join(home, ".tokenomy", "config.json"),
      JSON.stringify({ graph: { auto_refresh_on_read: false } }),
    );
    const cfg = loadConfig(home);
    assert.equal(cfg.graph.auto_refresh_on_read, false);
    // Other graph defaults should still be in place.
    assert.equal(cfg.graph.enabled, DEFAULT_CONFIG.graph.enabled);
  });
});
