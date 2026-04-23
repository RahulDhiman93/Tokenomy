import { test } from "node:test";
import assert from "node:assert/strict";
import { render, renderProgress } from "../../src/analyze/render.js";
import type { AggregateReport } from "../../src/analyze/report.js";

const stub: AggregateReport = {
  window: { first_ts: "2026-04-17T10:00:00Z", last_ts: "2026-04-18T12:00:00Z" },
  totals: {
    files: 3,
    sessions: 2,
    tool_calls: 12,
    observed_bytes: 100_000,
    observed_tokens: 25_000,
    savings_bytes: 60_000,
    savings_tokens: 15_000,
    redact_matches: 2,
    duplicate_calls: 4,
    estimated_usd_saved: 0.045,
    estimated_usd_observed: 0.075,
  },
  by_tool: [
    { tool: "mcp__Atlassian__getJiraIssue", calls: 3, observed_tokens: 10_000, savings_tokens: 8_000, waste_pct: 0.8, p50_latency_ms: 410, p95_latency_ms: 1200, latency_samples: 3 },
    { tool: "Read", calls: 5, observed_tokens: 9_000, savings_tokens: 5_000, waste_pct: 0.55, p50_latency_ms: null, p95_latency_ms: null, latency_samples: 0 },
  ],
  by_rule: [
    { rule: "profile", savings_tokens: 8_000, events: 3 },
    { rule: "read_clamp", savings_tokens: 5_000, events: 4 },
    { rule: "dedup", savings_tokens: 2_000, events: 2 },
  ],
  by_day: [
    { day: "2026-04-17", observed_tokens: 10_000, savings_tokens: 6_000 },
    { day: "2026-04-18", observed_tokens: 15_000, savings_tokens: 9_000 },
  ],
  hotspots: [{ tool: "mcp__Atlassian__getJiraIssue", calls: 3, wasted_tokens: 6_000 }],
  wasted_probes: [
    {
      tool: "mcp__claude_ai_Atlassian__getTransitionsForJiraIssue",
      session_id: "abcdef12",
      first_ts: "2026-04-20T10:00:00Z",
      last_ts: "2026-04-20T10:00:45Z",
      call_count: 4,
      observed_tokens: 2_400,
    },
  ],
  outliers: [
    { tool: "mcp__Atlassian__getJiraIssue", tokens: 4_000, bytes: 16_000, ts: "2026-04-17T11:00:00Z", session_id: "abcdef12" },
  ],
  tokenizer: { name: "heuristic", approximate: true },
};

test("render: plain output (no color) contains summary numbers", () => {
  const out = render(stub, { color: false, width: 100, verbose: false });
  assert.ok(out.includes("tokenomy analyze"));
  assert.ok(out.includes("25,000")); // observed tokens
  assert.ok(out.includes("15,000")); // savings tokens
  assert.ok(out.includes("$0.0450"));
});

test("render: lists top tools and by_rule", () => {
  const out = render(stub, { color: false, width: 100, verbose: false });
  assert.ok(out.includes("mcp__Atlassian__getJiraIssue"));
  assert.ok(out.includes("Schema-aware profile trim"));
  assert.ok(out.includes("Read clamp"));
});

test("render: shows redact warning when matches > 0", () => {
  const out = render(stub, { color: false, width: 100, verbose: false });
  assert.ok(out.includes("Secret-pattern matches"));
});

test("render: verbose adds per-day table", () => {
  const out = render(stub, { color: false, width: 100, verbose: true });
  assert.ok(out.includes("2026-04-17"));
  assert.ok(out.includes("2026-04-18"));
});

test("render: renderProgress produces carriage-returned status", () => {
  const s = renderProgress(5, 10, 1_000_000, 2_000, false, 100);
  assert.ok(s.startsWith("\r"));
  assert.ok(s.includes("5/10"));
});

test("render: wasted-probe section appears when incidents present", () => {
  const out = render(stub, { color: false, width: 120, verbose: false });
  assert.ok(out.includes("Wasted-probe incidents"));
  assert.ok(out.includes("getTransitionsForJiraIssue"));
  assert.ok(out.includes("4×"));
  assert.ok(out.includes("10:00:00→10:00:45"));
});

test("render: empty report doesn't throw", () => {
  const empty: AggregateReport = {
    window: { first_ts: null, last_ts: null },
    totals: {
      files: 0,
      sessions: 0,
      tool_calls: 0,
      observed_bytes: 0,
      observed_tokens: 0,
      savings_bytes: 0,
      savings_tokens: 0,
      redact_matches: 0,
      duplicate_calls: 0,
      estimated_usd_saved: 0,
      estimated_usd_observed: 0,
    },
    by_tool: [],
    by_rule: [],
    by_day: [],
    hotspots: [],
    wasted_probes: [],
    outliers: [],
    tokenizer: { name: "heuristic", approximate: true },
  };
  const out = render(empty, { color: false, width: 80, verbose: false });
  assert.ok(out.includes("no events"));
});
