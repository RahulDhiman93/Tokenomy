import { test } from "node:test";
import assert from "node:assert/strict";
import { Simulator } from "../../src/analyze/simulate.js";
import { heuristicTokenizer } from "../../src/analyze/tokens.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { ToolCall } from "../../src/analyze/parse.js";

const mkCall = (over: Partial<ToolCall>): ToolCall => ({
  agent: "claude-code",
  session_id: "s1",
  project_hint: "p",
  ts: "2026-04-18T12:00:00Z",
  tool_name: "mcp__x__y",
  tool_input: {},
  tool_response: null,
  is_error: false,
  response_bytes: 0,
  ...over,
});

const makeSim = () =>
  new Simulator({
    cfg: { ...DEFAULT_CONFIG, aggression: "balanced" },
    tokenizer: heuristicTokenizer,
  });

test("simulator: duplicate in same session and within window is flagged", () => {
  const sim = makeSim();
  const body = { content: [{ type: "text", text: "x".repeat(4000) }] };
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const first = sim.feed(
    mkCall({
      ts: "2026-04-18T12:00:00Z",
      tool_input: { id: 1 },
      tool_response: body,
      response_bytes: bytes,
    }),
  );
  assert.equal(first.duplicate_of_index, undefined);

  const second = sim.feed(
    mkCall({
      ts: "2026-04-18T12:01:00Z", // within default 1800s window
      tool_input: { id: 1 },
      tool_response: body,
      response_bytes: bytes,
    }),
  );
  assert.equal(second.duplicate_of_index, 1);
  assert.ok(second.per_rule.dedup > 0);
  assert.ok(second.savings_tokens > 0);
});

test("simulator: different sessions do not cross-contaminate dedup", () => {
  const sim = makeSim();
  const body = { content: [{ type: "text", text: "x".repeat(4000) }] };
  const call1 = mkCall({
    session_id: "s1",
    tool_input: { id: 1 },
    tool_response: body,
    response_bytes: 9999,
  });
  const call2 = mkCall({
    session_id: "s2",
    tool_input: { id: 1 },
    tool_response: body,
    response_bytes: 9999,
  });
  sim.feed(call1);
  const r = sim.feed(call2);
  assert.equal(r.duplicate_of_index, undefined);
});

test("simulator: non-MCP stacktrace is NOT counted (matches real dispatch)", () => {
  const sim = makeSim();
  const trace =
    "Error: boom\n" +
    "    at foo (/a.ts:1:1)\n".repeat(10) +
    "    at root (/z.ts:1:1)";
  const call = mkCall({
    tool_name: "Bash", // non-MCP — live dispatch skips all PostToolUse rules
    tool_response: trace,
    response_bytes: Buffer.byteLength(trace, "utf8"),
  });
  const r = sim.feed(call);
  assert.equal(r.per_rule.stacktrace, 0);
  assert.equal(r.savings_tokens, 0);
});

test("simulator: MCP response with stacktrace is credited to mcp-content-rule (no double-count)", () => {
  const sim = makeSim();
  const trace =
    "Error: boom\n" +
    "    at foo (/a.ts:1:1)\n".repeat(20) +
    "    at root (/z.ts:1:1)";
  const body = { content: [{ type: "text", text: trace }] };
  const call = mkCall({
    tool_name: "mcp__x__y",
    tool_response: body,
    response_bytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
  });
  const r = sim.feed(call);
  // savings_tokens must never exceed observed_tokens (the double-count bug).
  assert.ok(r.savings_tokens <= r.observed_tokens);
});

test("simulator: MCP trim produces savings for oversized JSON response", () => {
  const sim = makeSim();
  const body = {
    content: [{ type: "text", text: "y".repeat(50_000) }],
  };
  const call = mkCall({
    tool_name: "mcp__test__big",
    tool_response: body,
    response_bytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
  });
  const r = sim.feed(call);
  assert.ok(r.savings_tokens > 0);
  // mcp_trim or profile must have fired.
  assert.ok(r.per_rule.mcp_trim > 0 || r.per_rule.profile > 0);
});

test("simulator: secret pattern in MCP response increments redact_matches", () => {
  const sim = makeSim();
  const awsKey = "AKIA" + "IOSFODNN7" + "EXAMPLE";
  const body = { content: [{ type: "text", text: `token=${awsKey} here` }] };
  const call = mkCall({
    tool_name: "mcp__x__y",
    tool_response: body,
    response_bytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
  });
  const r = sim.feed(call);
  assert.equal(r.per_rule.redact_matches, 1);
});

test("simulator: non-MCP secret does NOT count redact_matches (matches dispatch)", () => {
  const sim = makeSim();
  const awsKey = "AKIA" + "IOSFODNN7" + "EXAMPLE";
  const text = `token=${awsKey} here`;
  const call = mkCall({
    tool_name: "Bash",
    tool_response: text,
    response_bytes: Buffer.byteLength(text, "utf8"),
  });
  const r = sim.feed(call);
  assert.equal(r.per_rule.redact_matches, 0);
});

test("simulator: dedup respects window_seconds", () => {
  const sim = new Simulator({
    cfg: {
      ...DEFAULT_CONFIG,
      aggression: "balanced",
      dedup: { enabled: true, min_bytes: 1000, window_seconds: 60 },
    },
    tokenizer: heuristicTokenizer,
  });
  const body = { content: [{ type: "text", text: "x".repeat(4000) }] };
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  // First call at t=0
  const first = sim.feed(
    mkCall({
      ts: "2026-04-18T12:00:00Z",
      tool_input: { id: 1 },
      tool_response: body,
      response_bytes: bytes,
    }),
  );
  assert.equal(first.duplicate_of_index, undefined);
  // Second call at t=61s (outside window) — should NOT be deduped.
  const second = sim.feed(
    mkCall({
      ts: "2026-04-18T12:01:01Z",
      tool_input: { id: 1 },
      tool_response: body,
      response_bytes: bytes,
    }),
  );
  assert.equal(second.duplicate_of_index, undefined);
  assert.equal(second.per_rule.dedup, 0);
});

test("simulator: Read with no explicit limit + many-line large response fires read_clamp", () => {
  const sim = makeSim();
  // 2000 lines × 50 chars = 100 KB; default injected_limit is 500 lines.
  const text = Array.from({ length: 2000 }, (_, i) => `line-${i}-padding-padding-padding-padding`).join("\n");
  const call = mkCall({
    tool_name: "Read",
    tool_input: { file_path: "/big" },
    tool_response: text,
    response_bytes: Buffer.byteLength(text, "utf8"),
  });
  const r = sim.feed(call);
  assert.ok(r.per_rule.read_clamp > 0);
});

test("simulator: Read of single-line minified bundle does NOT credit read_clamp", () => {
  const sim = makeSim();
  // One long line — limit: 500 lines returns the whole file, no savings.
  const text = "x".repeat(80_000);
  const call = mkCall({
    tool_name: "Read",
    tool_input: { file_path: "/minified" },
    tool_response: text,
    response_bytes: text.length,
  });
  const r = sim.feed(call);
  assert.equal(r.per_rule.read_clamp, 0);
});

test("simulator: Read with explicit limit does not fire read_clamp", () => {
  const sim = makeSim();
  const text = Array.from({ length: 2000 }, () => "x".repeat(40)).join("\n");
  const call = mkCall({
    tool_name: "Read",
    tool_input: { file_path: "/big", limit: 100 },
    tool_response: text,
    response_bytes: Buffer.byteLength(text, "utf8"),
  });
  const r = sim.feed(call);
  assert.equal(r.per_rule.read_clamp, 0);
});
