import { test } from "node:test";
import assert from "node:assert/strict";
import { replayOne, responseAsText } from "../../src/analyze/replay.js";
import { heuristicTokenizer } from "../../src/analyze/tokens.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { ToolCall } from "../../src/analyze/parse.js";

test("replayOne: Read call over clamp threshold credits read_clamp", () => {
  const body = Array(5000).fill("const x = 1;").join("\n");
  const call: ToolCall = {
    agent: "claude-code",
    session_id: "s1",
    project_hint: "nonexistent-project-hint",
    ts: "2026-04-20T10:00:00Z",
    tool_name: "Read",
    tool_input: { file_path: "/tmp/big.ts" },
    tool_response: body,
    is_error: false,
    response_bytes: Buffer.byteLength(body, "utf8"),
  };
  const { event, before, beforeTokens, afterTokens } = replayOne(
    call,
    DEFAULT_CONFIG,
    heuristicTokenizer,
  );
  assert.ok(before.length > 1000);
  assert.equal(beforeTokens, event.observed_tokens);
  assert.ok(afterTokens < beforeTokens);
  assert.ok(event.per_rule.read_clamp > 0, "read_clamp should be credited");
});

test("responseAsText: array of text blocks joins with newlines", () => {
  const blocks = [
    { type: "text", text: "hello" },
    { type: "text", text: "world" },
  ];
  assert.equal(responseAsText(blocks), "hello\nworld");
});

test("responseAsText: MCP {content: [...]} shape unwraps", () => {
  const r = { content: [{ type: "text", text: "inner" }] };
  assert.equal(responseAsText(r), "inner");
});

test("responseAsText: plain string passes through", () => {
  assert.equal(responseAsText("plain"), "plain");
});

test("responseAsText: null → empty", () => {
  assert.equal(responseAsText(null), "");
});
