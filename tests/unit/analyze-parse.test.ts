import { test } from "node:test";
import assert from "node:assert/strict";
import { feedLine, makeState, type ToolCall } from "../../src/analyze/parse.js";

const collect = (lines: string[], session = "s1", project = "p1"): ToolCall[] => {
  const state = makeState(session, project);
  const out: ToolCall[] = [];
  for (const l of lines) feedLine(l, state, (c) => out.push(c));
  return out;
};

test("parse: pairs Claude Code tool_use with tool_result", () => {
  const useLine = JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-18T12:00:00Z",
    message: {
      content: [
        { type: "text", text: "calling read" },
        { type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/tmp/x" } },
      ],
    },
  });
  const resultLine = JSON.stringify({
    type: "user",
    timestamp: "2026-04-18T12:00:05Z",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "file contents", is_error: false },
      ],
    },
  });
  const calls = collect([useLine, resultLine]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool_name, "Read");
  assert.equal(calls[0]!.tool_input.file_path, "/tmp/x");
  assert.equal(calls[0]!.tool_response, "file contents");
  assert.equal(calls[0]!.is_error, false);
  assert.equal(calls[0]!.agent, "claude-code");
  assert.equal(calls[0]!.session_id, "s1");
});

test("parse: orphan tool_result without matching use is dropped", () => {
  const resultLine = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "orphan", content: "x" }] },
  });
  const calls = collect([resultLine]);
  assert.equal(calls.length, 0);
});

test("parse: handles MCP list-shape content", () => {
  const use = JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-18T12:00:00Z",
    message: { content: [{ type: "tool_use", id: "tu_2", name: "mcp__x__y", input: {} }] },
  });
  const result = JSON.stringify({
    type: "user",
    timestamp: "2026-04-18T12:00:05Z",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_2",
          content: [
            { type: "text", text: "hello" },
            { type: "image", data: "base64" },
          ],
        },
      ],
    },
  });
  const calls = collect([use, result]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool_name, "mcp__x__y");
  assert.ok(Array.isArray(calls[0]!.tool_response));
});

test("parse: malformed JSON line is skipped", () => {
  const calls = collect(["not json", "", "{"]);
  assert.equal(calls.length, 0);
});

test("parse: Codex rollout function_call + function_call_output pair", () => {
  const call = JSON.stringify({
    type: "response_item",
    timestamp: "2026-04-18T12:00:00Z",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "ls", workdir: "/tmp" }),
      call_id: "call_abc",
    },
  });
  const output = JSON.stringify({
    type: "response_item",
    timestamp: "2026-04-18T12:00:01Z",
    payload: {
      type: "function_call_output",
      call_id: "call_abc",
      output: "file1\nfile2\n",
    },
  });
  const calls = collect([call, output]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool_name, "exec_command");
  assert.equal(calls[0]!.agent, "codex");
  assert.equal((calls[0]!.tool_input as { cmd?: string }).cmd, "ls");
  assert.equal(calls[0]!.tool_response, "file1\nfile2\n");
});

test("parse: Codex function_call_output without matching call is dropped", () => {
  const output = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "orphan", output: "x" },
  });
  const calls = collect([output]);
  assert.equal(calls.length, 0);
});
