import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMarkdown, escCell } from "../../src/cli/ci.js";
import type { AggregateReport } from "../../src/analyze/report.js";

const stub: AggregateReport = {
  window: { first_ts: "2026-04-01T10:00:00Z", last_ts: "2026-04-22T10:00:00Z" },
  totals: {
    files: 3,
    sessions: 2,
    tool_calls: 20,
    observed_bytes: 500_000,
    observed_tokens: 100_000,
    savings_bytes: 300_000,
    savings_tokens: 60_000,
    redact_matches: 0,
    duplicate_calls: 2,
    estimated_usd_saved: 0.18,
    estimated_usd_observed: 0.3,
  },
  by_tool: [
    {
      tool: "Bash",
      calls: 10,
      observed_tokens: 60_000,
      savings_tokens: 40_000,
      waste_pct: 0.66,
      p50_latency_ms: 200,
      p95_latency_ms: 900,
      latency_samples: 10,
    },
  ],
  by_rule: [{ rule: "bash_bound", savings_tokens: 40_000, events: 10 }],
  by_day: [],
  hotspots: [],
  wasted_probes: [],
  outliers: [],
  tokenizer: { name: "heuristic", approximate: true },
};

test("formatMarkdown: emits summary + rule + tool tables", () => {
  const md = formatMarkdown(stub);
  assert.ok(md.includes("Tokenomy — token-waste summary"));
  assert.ok(md.includes("100,000"));
  assert.ok(md.includes("60,000"));
  assert.ok(md.includes("$0.1800"));
  assert.ok(md.includes("bash_bound"));
  assert.ok(md.includes("`Bash`"));
});

test("formatMarkdown: hides secret row when redact_matches=0", () => {
  const md = formatMarkdown(stub);
  assert.ok(!md.includes("Secret matches"));
});

test("escCell: pipe / HTML / newline / backtick are neutralized", () => {
  const out = escCell(`evil|name\n<script>alert(1)</script>\`bad\``);
  // No unescaped pipe — would split a row.
  assert.ok(!/(?<!\\)\|/.test(out));
  // No unescaped newline — would spill to next row.
  assert.ok(!out.includes("\n"));
  // HTML angle brackets encoded.
  assert.ok(out.includes("&lt;script&gt;"));
  // Backtick escaped.
  assert.ok(out.includes("\\`"));
});

test("escCell: clamps extremely long cell", () => {
  const out = escCell("x".repeat(5000));
  assert.ok(out.length <= 220);
  assert.ok(out.endsWith("…"));
});

test("formatMarkdown: attacker tool name with `|` + HTML escapes cleanly", () => {
  const bad: typeof stub = {
    ...stub,
    by_tool: [
      { ...stub.by_tool[0]!, tool: "evil|name<script>" },
    ],
  };
  const md = formatMarkdown(bad);
  assert.ok(md.includes("\\|"));
  assert.ok(md.includes("&lt;script&gt;"));
  assert.ok(!md.includes("<script>"));
});
