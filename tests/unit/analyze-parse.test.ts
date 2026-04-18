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

test("parse: Codex namespace + name produce mcp__* tool names", () => {
  const call = JSON.stringify({
    type: "response_item",
    timestamp: "2026-04-18T12:00:00Z",
    payload: {
      type: "function_call",
      namespace: "mcp__codex_apps__github",
      name: "_search_prs",
      arguments: JSON.stringify({ repo: "x/y" }),
      call_id: "call_xy",
    },
  });
  const output = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_xy", output: "Output:\n[]" },
  });
  const calls = collect([call, output]);
  assert.equal(calls.length, 1);
  // Leading underscore on the method fuses with the namespace's trailing
  // character to yield a proper `__` separator.
  assert.equal(calls[0]!.tool_name, "mcp__codex_apps__github__search_prs");
  assert.ok(calls[0]!.tool_name.startsWith("mcp__"));
});

test("parse: Codex namespace + underscore-less name uses __ separator", () => {
  const call = JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call",
      namespace: "mcp__codex_apps__github",
      name: "search",
      arguments: "{}",
      call_id: "call_no_us",
    },
  });
  const output = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_no_us", output: "Output:\nx" },
  });
  const calls = collect([call, output]);
  assert.equal(calls[0]!.tool_name, "mcp__codex_apps__github__search");
});

test("parse: Codex CLI wrapper is stripped from function_call_output", () => {
  const call = JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: "{}",
      call_id: "call_wrap",
    },
  });
  const wrapped =
    "Chunk ID: abc\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 5\nOutput:\nHello world";
  const output = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_wrap", output: wrapped },
  });
  const calls = collect([call, output]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.tool_response, "Hello world");
});

test("parse: Codex wrapped JSON payload is parsed back into an object (MCP tool)", () => {
  const call = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", namespace: "mcp__x__y", name: "z", arguments: "{}", call_id: "call_js" },
  });
  const payload = { content: [{ type: "text", text: "hi" }] };
  const wrapped = `Wall time: 0.1s\nOutput:\n${JSON.stringify(payload)}`;
  const output = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_js", output: wrapped },
  });
  const calls = collect([call, output]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.tool_response, payload);
});

test("parse: Codex MCP output wrapped into {content:[text]} shape when bare JSON", () => {
  const call = JSON.stringify({
    type: "response_item",
    payload: {
      type: "function_call",
      namespace: "mcp__codex_apps__github",
      name: "_search_prs",
      arguments: "{}",
      call_id: "call_bare",
    },
  });
  const bare = JSON.stringify({ issues: [{ id: 1, title: "x" }] });
  const output = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_bare", output: `Output:\n${bare}` },
  });
  const calls = collect([call, output]);
  assert.equal(calls.length, 1);
  const resp = calls[0]!.tool_response as { content?: unknown };
  assert.ok(resp && typeof resp === "object");
  // Wrapper inserted so mcpContentRule can traverse text blocks.
  assert.ok(Array.isArray(resp.content));
});

test("parse: Codex wrapper's 'Original token count: N' is captured as override", () => {
  const call = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", name: "exec_command", arguments: "{}", call_id: "call_tok" },
  });
  const wrapped = `Chunk ID: abc\nWall time: 0.1\nProcess exited with code 0\nOriginal token count: 423\nOutput:\nhello world`;
  const output = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_tok", output: wrapped },
  });
  const calls = collect([call, output]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.observed_tokens_override, 423);
});

test("parse: non-MCP Codex tool with JSON-looking output stays a string", () => {
  const call = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call", name: "exec_command", arguments: "{}", call_id: "call_cat" },
  });
  const prettyJson = '{\n  "name": "foo",\n  "version": "1.0.0"\n}';
  const wrapped = `Wall time: 0.1s\nOutput:\n${prettyJson}`;
  const output = JSON.stringify({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "call_cat", output: wrapped },
  });
  const calls = collect([call, output]);
  assert.equal(calls.length, 1);
  // Shell outputs stay as strings even when they happen to be JSON —
  // otherwise `cat package.json` gets mis-parsed into an object and
  // downstream tooling miscounts it.
  assert.equal(typeof calls[0]!.tool_response, "string");
  assert.equal(calls[0]!.tool_response, prettyJson);
});

test("parse: upgrades identity from Claude Code sessionId + cwd fields", () => {
  const use = JSON.stringify({
    type: "assistant",
    timestamp: "2026-04-18T12:00:00Z",
    sessionId: "real-session",
    cwd: "/Users/me/actual-project",
    message: {
      content: [{ type: "tool_use", id: "tu", name: "Read", input: { file_path: "/x" } }],
    },
  });
  const result = JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tu", content: "x" }] },
  });
  const calls = collect([use, result], "fallback-session", "fallback-project");
  assert.equal(calls[0]!.session_id, "real-session");
  assert.equal(calls[0]!.project_hint, "/Users/me/actual-project");
});
