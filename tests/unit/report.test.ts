import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "../../src/cli/report.js";
import type { SavingsLogEntry } from "../../src/core/types.js";

const mkEntry = (overrides: Partial<SavingsLogEntry>): SavingsLogEntry => ({
  ts: "2026-04-17T12:00:00Z",
  session_id: "s",
  tool: "mcp__x__y",
  bytes_in: 10_000,
  bytes_out: 2_000,
  tokens_saved_est: 2_000,
  reason: "mcp-content-trim",
  ...overrides,
});

test("summarize: aggregates totals", () => {
  const entries = [
    mkEntry({ tokens_saved_est: 100, bytes_in: 1000, bytes_out: 500 }),
    mkEntry({ tokens_saved_est: 300, bytes_in: 2000, bytes_out: 500 }),
  ];
  const s = summarize(entries, { top: 5, pricePerMillion: 3 });
  assert.equal(s.total_calls, 2);
  assert.equal(s.total_tokens_saved, 400);
  assert.equal(s.total_bytes_in, 3_000);
  assert.equal(s.total_bytes_out, 1_000);
  assert.ok(Math.abs(s.estimated_usd_saved - (400 / 1_000_000) * 3) < 1e-9);
});

test("summarize: top N by tokens saved", () => {
  const entries = [
    mkEntry({ tool: "a", tokens_saved_est: 100 }),
    mkEntry({ tool: "b", tokens_saved_est: 300 }),
    mkEntry({ tool: "c", tokens_saved_est: 200 }),
    mkEntry({ tool: "d", tokens_saved_est: 50 }),
  ];
  const s = summarize(entries, { top: 2, pricePerMillion: 3 });
  assert.deepEqual(
    s.by_tool.map((t) => t.tool),
    ["b", "c"],
  );
});

test("summarize: reason grouping collapses profile:<name> variants", () => {
  const entries = [
    mkEntry({ reason: "profile:atlassian-jira-issue" }),
    mkEntry({ reason: "profile:linear-issue" }),
    mkEntry({ reason: "mcp-content-trim" }),
  ];
  const s = summarize(entries, { top: 10, pricePerMillion: 3 });
  const names = s.by_reason.map((r) => r.reason).sort();
  assert.ok(names.includes("profile"));
  assert.ok(names.includes("mcp-content-trim"));
});

test("summarize: window carries first/last ts", () => {
  const entries = [
    mkEntry({ ts: "2026-04-17T10:00:00Z" }),
    mkEntry({ ts: "2026-04-17T15:00:00Z" }),
    mkEntry({ ts: "2026-04-16T08:00:00Z" }),
  ];
  const s = summarize(entries, { top: 5, pricePerMillion: 3 });
  assert.equal(s.window.first_ts, "2026-04-16T08:00:00Z");
  assert.equal(s.window.last_ts, "2026-04-17T15:00:00Z");
});

test("summarize: by_day is sorted chronologically", () => {
  const entries = [
    mkEntry({ ts: "2026-04-17T10:00:00Z" }),
    mkEntry({ ts: "2026-04-15T10:00:00Z" }),
    mkEntry({ ts: "2026-04-16T10:00:00Z" }),
  ];
  const s = summarize(entries, { top: 5, pricePerMillion: 3 });
  assert.deepEqual(
    s.by_day.map((d) => d.day),
    ["2026-04-15", "2026-04-16", "2026-04-17"],
  );
});

test("summarize: empty entries", () => {
  const s = summarize([], { top: 5, pricePerMillion: 3 });
  assert.equal(s.total_calls, 0);
  assert.equal(s.total_tokens_saved, 0);
  assert.equal(s.estimated_usd_saved, 0);
  assert.equal(s.window.first_ts, null);
});
