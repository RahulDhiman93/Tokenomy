import { test } from "node:test";
import assert from "node:assert/strict";
import { Aggregator } from "../../src/analyze/report.js";
import type { SimEvent } from "../../src/analyze/simulate.js";

const mk = (over: Partial<SimEvent>): SimEvent => ({
  agent: "claude-code",
  session_id: "s1",
  project_hint: "p1",
  ts: "2026-04-18T10:00:00Z",
  tool_name: "mcp__x",
  observed_bytes: 1000,
  observed_tokens: 200,
  savings_bytes: 500,
  savings_tokens: 100,
  per_rule: { dedup: 0, redact_matches: 0, stacktrace: 0, profile: 100, mcp_trim: 0, read_clamp: 0, bash_bound: 0 },
  call_key: "k1",
  ...over,
});

const agg = () =>
  new Aggregator({
    top_n: 5,
    price_per_million: 3,
    tokenizer_name: "heuristic",
    tokenizer_approximate: true,
  });

test("aggregator: totals are summed correctly", () => {
  const a = agg();
  a.feed(mk({}));
  a.feed(mk({ observed_tokens: 400, savings_tokens: 300, per_rule: { dedup: 300, redact_matches: 0, stacktrace: 0, profile: 0, mcp_trim: 0, read_clamp: 0, bash_bound: 0 } }));
  const r = a.build();
  assert.equal(r.totals.tool_calls, 2);
  assert.equal(r.totals.observed_tokens, 600);
  assert.equal(r.totals.savings_tokens, 400);
});

test("aggregator: by_tool sorted by savings tokens desc", () => {
  const a = agg();
  a.feed(mk({ tool_name: "a", observed_tokens: 100, savings_tokens: 10, per_rule: { dedup: 0, redact_matches: 0, stacktrace: 0, profile: 10, mcp_trim: 0, read_clamp: 0, bash_bound: 0 } }));
  a.feed(mk({ tool_name: "b", observed_tokens: 100, savings_tokens: 80, per_rule: { dedup: 0, redact_matches: 0, stacktrace: 0, profile: 80, mcp_trim: 0, read_clamp: 0, bash_bound: 0 } }));
  const r = a.build();
  assert.equal(r.by_tool[0]!.tool, "b");
  assert.equal(r.by_tool[1]!.tool, "a");
});

test("aggregator: hotspots are session-scoped (same key in two sessions isn't a hotspot)", () => {
  const a = agg();
  a.feed(mk({ session_id: "s1", call_key: "k1", tool_name: "t1", observed_tokens: 100 }));
  a.feed(mk({ session_id: "s2", call_key: "k1", tool_name: "t1", observed_tokens: 100 }));
  const r = a.build();
  // Same call_key across sessions ≠ hotspot; real dedup is session-scoped.
  assert.equal(r.hotspots.length, 0);
});

test("aggregator: hotspots only surface simulator-confirmed duplicates", () => {
  const a = agg();
  a.feed(mk({ call_key: "k1", tool_name: "t1", observed_tokens: 100 }));
  // These repeats were flagged as duplicates by the simulator → counted.
  a.feed(mk({ call_key: "k1", tool_name: "t1", observed_tokens: 100, duplicate_of_index: 1 }));
  a.feed(mk({ call_key: "k1", tool_name: "t1", observed_tokens: 100, duplicate_of_index: 1 }));
  // A second key with only "repeat" count but no duplicate flag — should
  // be filtered out of the hotspots list (simulator didn't credit savings).
  a.feed(mk({ call_key: "k2", tool_name: "t2", observed_tokens: 500 }));
  a.feed(mk({ call_key: "k2", tool_name: "t2", observed_tokens: 500 }));
  const r = a.build();
  assert.equal(r.hotspots.length, 1);
  assert.equal(r.hotspots[0]!.calls, 3);
  assert.equal(r.hotspots[0]!.wasted_tokens, 200);
});

test("aggregator: outliers top-N by observed tokens", () => {
  const a = agg();
  for (let i = 0; i < 20; i++) a.feed(mk({ observed_tokens: i * 100 }));
  const r = a.build();
  assert.equal(r.outliers.length, 5);
  // First should be the largest (19*100 = 1900).
  assert.equal(r.outliers[0]!.tokens, 1900);
});

test("aggregator: by_day bucketed by UTC date", () => {
  const a = agg();
  a.feed(mk({ ts: "2026-04-18T10:00:00Z", observed_tokens: 100 }));
  a.feed(mk({ ts: "2026-04-18T22:00:00Z", observed_tokens: 200 }));
  a.feed(mk({ ts: "2026-04-19T09:00:00Z", observed_tokens: 50 }));
  const r = a.build();
  assert.equal(r.by_day.length, 2);
  assert.equal(r.by_day[0]!.day, "2026-04-18");
  assert.equal(r.by_day[0]!.observed_tokens, 300);
});

test("aggregator: usd calculation", () => {
  const a = new Aggregator({ top_n: 5, price_per_million: 10, tokenizer_name: "h", tokenizer_approximate: true });
  a.feed(mk({ observed_tokens: 1_000_000, savings_tokens: 500_000 }));
  const r = a.build();
  assert.ok(Math.abs(r.totals.estimated_usd_saved - 5) < 1e-6);
  assert.ok(Math.abs(r.totals.estimated_usd_observed - 10) < 1e-6);
});

test("aggregator: wasted_probes detects 4-call run with distinct args in 60s window", () => {
  const a = agg();
  const tool = "mcp__claude_ai_Atlassian__getTransitionsForJiraIssue";
  // Four calls 10s apart, each with different call_keys (the agent probing
  // different transitionIds / issueKeys). Total window: 30s < 60s.
  a.feed(mk({ tool_name: tool, call_key: "k-a", ts: "2026-04-20T10:00:00Z", observed_tokens: 500 }));
  a.feed(mk({ tool_name: tool, call_key: "k-b", ts: "2026-04-20T10:00:10Z", observed_tokens: 500 }));
  a.feed(mk({ tool_name: tool, call_key: "k-c", ts: "2026-04-20T10:00:20Z", observed_tokens: 500 }));
  a.feed(mk({ tool_name: tool, call_key: "k-d", ts: "2026-04-20T10:00:30Z", observed_tokens: 500 }));
  const r = a.build();
  assert.equal(r.wasted_probes.length, 1);
  assert.equal(r.wasted_probes[0]!.tool, tool);
  assert.equal(r.wasted_probes[0]!.call_count, 4);
  assert.equal(r.wasted_probes[0]!.observed_tokens, 2000);
  assert.equal(r.wasted_probes[0]!.first_ts, "2026-04-20T10:00:00Z");
  assert.equal(r.wasted_probes[0]!.last_ts, "2026-04-20T10:00:30Z");
});

test("aggregator: wasted_probes ignores 2-call run (below threshold)", () => {
  const a = agg();
  const tool = "mcp__x__y";
  a.feed(mk({ tool_name: tool, call_key: "k-a", ts: "2026-04-20T10:00:00Z" }));
  a.feed(mk({ tool_name: tool, call_key: "k-b", ts: "2026-04-20T10:00:10Z" }));
  const r = a.build();
  assert.equal(r.wasted_probes.length, 0);
});

test("aggregator: wasted_probes ignores same-key repeats (dedup territory)", () => {
  const a = agg();
  const tool = "mcp__x__y";
  // Same call_key repeated 5 times — this is dedup's job, not a probe run.
  for (let i = 0; i < 5; i++) {
    a.feed(mk({
      tool_name: tool,
      call_key: "k-same",
      ts: `2026-04-20T10:00:${String(i * 5).padStart(2, "0")}Z`,
    }));
  }
  const r = a.build();
  assert.equal(r.wasted_probes.length, 0);
});

test("aggregator: wasted_probes splits runs when gap exceeds 60s", () => {
  const a = agg();
  const tool = "mcp__x__y";
  // Run 1: 3 calls at t=0,10,20 (distinct keys). Then gap. Run 2: 3 calls at t=120,130,140.
  a.feed(mk({ tool_name: tool, call_key: "r1-a", ts: "2026-04-20T10:00:00Z" }));
  a.feed(mk({ tool_name: tool, call_key: "r1-b", ts: "2026-04-20T10:00:10Z" }));
  a.feed(mk({ tool_name: tool, call_key: "r1-c", ts: "2026-04-20T10:00:20Z" }));
  a.feed(mk({ tool_name: tool, call_key: "r2-a", ts: "2026-04-20T10:02:00Z" }));
  a.feed(mk({ tool_name: tool, call_key: "r2-b", ts: "2026-04-20T10:02:10Z" }));
  a.feed(mk({ tool_name: tool, call_key: "r2-c", ts: "2026-04-20T10:02:20Z" }));
  const r = a.build();
  assert.equal(r.wasted_probes.length, 2);
});

test("aggregator: wasted_probes is per-session", () => {
  const a = agg();
  const tool = "mcp__x__y";
  // Same tool, distinct args, but spread across two sessions — neither
  // session alone crosses the 3-call threshold.
  a.feed(mk({ tool_name: tool, session_id: "s1", call_key: "a", ts: "2026-04-20T10:00:00Z" }));
  a.feed(mk({ tool_name: tool, session_id: "s2", call_key: "b", ts: "2026-04-20T10:00:10Z" }));
  a.feed(mk({ tool_name: tool, session_id: "s1", call_key: "c", ts: "2026-04-20T10:00:20Z" }));
  a.feed(mk({ tool_name: tool, session_id: "s2", call_key: "d", ts: "2026-04-20T10:00:30Z" }));
  const r = a.build();
  assert.equal(r.wasted_probes.length, 0);
});
