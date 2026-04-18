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

test("simulator: duplicate in same session is flagged and credits savings", () => {
  const sim = makeSim();
  const body = { content: [{ type: "text", text: "x".repeat(4000) }] };
  const call = mkCall({
    tool_input: { id: 1 },
    tool_response: body,
    response_bytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
  });

  const first = sim.feed(call);
  assert.equal(first.duplicate_of_index, undefined);

  const second = sim.feed(call);
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

test("simulator: stacktrace-shaped response is collapsed", () => {
  const sim = makeSim();
  const trace =
    "Error: boom\n" +
    "    at foo (/a.ts:1:1)\n".repeat(10) +
    "    at root (/z.ts:1:1)";
  const call = mkCall({
    tool_name: "Bash",
    tool_response: trace,
    response_bytes: Buffer.byteLength(trace, "utf8"),
  });
  const r = sim.feed(call);
  assert.ok(r.per_rule.stacktrace > 0);
  assert.ok(r.savings_tokens > 0);
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

test("simulator: secret pattern in response increments redact_matches", () => {
  const sim = makeSim();
  const text = `token=AKIA${"IOSFODNN7EXAMPLE"} here`;
  const call = mkCall({
    tool_name: "Bash",
    tool_response: text,
    response_bytes: Buffer.byteLength(text, "utf8"),
  });
  const r = sim.feed(call);
  assert.equal(r.per_rule.redact_matches, 1);
});

test("simulator: Read with no explicit limit + large response fires read_clamp", () => {
  const sim = makeSim();
  const text = "x".repeat(80_000);
  const call = mkCall({
    tool_name: "Read",
    tool_input: { file_path: "/big" },
    tool_response: text,
    response_bytes: text.length,
  });
  const r = sim.feed(call);
  assert.ok(r.per_rule.read_clamp > 0);
});

test("simulator: Read with explicit limit does not fire read_clamp", () => {
  const sim = makeSim();
  const text = "x".repeat(80_000);
  const call = mkCall({
    tool_name: "Read",
    tool_input: { file_path: "/big", limit: 100 },
    tool_response: text,
    response_bytes: text.length,
  });
  const r = sim.feed(call);
  assert.equal(r.per_rule.read_clamp, 0);
});
