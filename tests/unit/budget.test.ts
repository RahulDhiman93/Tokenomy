import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { budgetRule } from "../../src/rules/budget.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { analyzeCachePath } from "../../src/core/paths.js";
import type { Config } from "../../src/core/types.js";

const setupHome = () => {
  const dir = join(tmpdir(), `tokenomy-budget-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prev = process.env["HOME"];
  process.env["HOME"] = dir;
  return {
    home: dir,
    restore: () => {
      if (prev === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prev;
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
};

const seedCache = (byTool: Record<string, { mean_tokens_per_call: number }>): void => {
  const path = analyzeCachePath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      generated_ts: new Date().toISOString(),
      byTool: Object.fromEntries(
        Object.entries(byTool).map(([tool, v]) => [tool, { calls: 10, ...v }]),
      ),
    }),
    "utf8",
  );
};

const enabled = (): Config => ({
  ...DEFAULT_CONFIG,
  budget: {
    enabled: true,
    warn_threshold_tokens: 5_000,
    session_cap_tokens: 10_000,
    exclude_tools: ["Read", "Write", "Edit"],
  },
});

test("budget: disabled by default → passthrough", () => {
  const h = setupHome();
  try {
    const r = budgetRule("s1", "Bash", DEFAULT_CONFIG);
    assert.equal(r.kind, "passthrough");
  } finally {
    h.restore();
  }
});

test("budget: excluded tool → passthrough", () => {
  const h = setupHome();
  try {
    seedCache({ Read: { mean_tokens_per_call: 50_000 } });
    const r = budgetRule("s1", "Read", enabled());
    assert.equal(r.kind, "passthrough");
  } finally {
    h.restore();
  }
});

test("budget: cold start (no cache) → passthrough", () => {
  const h = setupHome();
  try {
    const r = budgetRule("s1", "Bash", enabled());
    assert.equal(r.kind, "passthrough");
  } finally {
    h.restore();
  }
});

test("budget: below warn threshold → passthrough + estimate reported", () => {
  const h = setupHome();
  try {
    seedCache({ Bash: { mean_tokens_per_call: 1_000 } });
    const r = budgetRule("s1", "Bash", enabled());
    assert.equal(r.kind, "passthrough");
    assert.equal(r.estimated_tokens, 1_000);
    assert.equal(r.running_total_after, 1_000);
  } finally {
    h.restore();
  }
});

test("budget: above threshold + projected over cap → warn", () => {
  const h = setupHome();
  try {
    seedCache({ Bash: { mean_tokens_per_call: 6_000 } });
    // First call: 0 + 6000 = 6000 ≤ cap 10000 → passthrough.
    const r1 = budgetRule("s1", "Bash", enabled());
    assert.equal(r1.kind, "passthrough");
    // Second call: 6000 + 6000 = 12000 > cap 10000 → warn.
    const r2 = budgetRule("s1", "Bash", enabled());
    assert.equal(r2.kind, "warn");
    assert.ok(r2.additionalContext?.includes("tokenomy-budget"));
    assert.ok(r2.additionalContext?.includes("6,000"));
  } finally {
    h.restore();
  }
});

test("budget: accumulates across calls", () => {
  const h = setupHome();
  try {
    seedCache({ Bash: { mean_tokens_per_call: 1_000 } });
    const cfg = enabled();
    for (let i = 0; i < 3; i++) budgetRule("sX", "Bash", cfg);
    const r = budgetRule("sX", "Bash", cfg);
    assert.equal(r.running_total_after, 4_000);
  } finally {
    h.restore();
  }
});
