import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpContentRule } from "../../src/rules/mcp-content.js";
import type { Config, McpToolResponse } from "../../src/core/types.js";

const CFG: Config = {
  aggression: "balanced",
  gate: { always_trim_above_bytes: 40_000, min_saved_bytes: 100, min_saved_pct: 0.1 },
  mcp: { max_text_bytes: 200, per_block_head: 50, per_block_tail: 20 },
  log_path: "/tmp/nope.jsonl",
  disabled_tools: [],
};

const makeBlob = (n: number): string => "A".repeat(n);

test("mcp: passthrough when under threshold", () => {
  const resp: McpToolResponse = { content: [{ type: "text", text: "hello world" }] };
  const r = mcpContentRule("mcp__x__y", {}, resp, CFG);
  assert.equal(r.kind, "passthrough");
});

test("mcp: passthrough when response has no content array", () => {
  const r = mcpContentRule("mcp__x__y", {}, { foo: "bar" }, CFG);
  assert.equal(r.kind, "passthrough");
});

test("mcp: trims long text, preserves non-text blocks, emits hint footer", () => {
  const resp: McpToolResponse = {
    content: [
      { type: "image", data: "base64...", mime: "image/png" },
      { type: "text", text: makeBlob(1_000) },
      { type: "image", data: "later-image" },
    ],
    is_error: false,
  };
  const r = mcpContentRule("mcp__x__y", {}, resp, CFG);
  assert.equal(r.kind, "trim");
  if (r.kind !== "trim") return;

  const out = r.output.content!;
  // Both image blocks preserved (never `break` — trailing non-text is kept)
  const images = out.filter((b) => b.type === "image");
  assert.equal(images.length, 2);

  // Hint footer present as text
  const last = out[out.length - 1] as { type: string; text: string };
  assert.equal(last.type, "text");
  assert.match(last.text, /\[tokenomy: response trimmed/);
  assert.match(last.text, /mcp__x__y/);

  // is_error preserved
  assert.equal(r.output.is_error, false);

  // Output shorter than input
  assert.ok(r.bytesOut < r.bytesIn);
});

test("mcp: multiple text blocks — first trimmed, later text replaced with marker", () => {
  const resp: McpToolResponse = {
    content: [
      { type: "text", text: makeBlob(1_000) },
      { type: "text", text: makeBlob(1_000) },
    ],
  };
  const r = mcpContentRule("mcp__x", {}, resp, CFG);
  assert.equal(r.kind, "trim");
  if (r.kind !== "trim") return;

  const texts = (r.output.content as Array<{ type: string; text: string }>).filter(
    (b) => b.type === "text",
  );
  // First trimmed contains elided marker
  assert.match(texts[0]!.text, /elided/);
  // Second is the short "subsequent text block elided" marker
  assert.match(texts[1]!.text, /subsequent text block elided/);
  // Last is the hint footer
  assert.match(texts[2]!.text, /response trimmed/);
});

test("mcp: supports raw-array shape (Atlassian/Claude Code wire format)", () => {
  const arr = [
    { type: "text", text: makeBlob(1_000) },
    { type: "image", data: "img" },
  ];
  const r = mcpContentRule("mcp__atlassian", {}, arr, CFG);
  assert.equal(r.kind, "trim");
  if (r.kind !== "trim") return;
  // Output must stay an array (not wrapped in {content})
  assert.equal(Array.isArray(r.output), true);
  const outArr = r.output as unknown as Array<{ type: string; text?: string }>;
  // Image preserved
  assert.ok(outArr.some((b) => b.type === "image"));
  // Hint footer
  const last = outArr[outArr.length - 1]!;
  assert.equal(last.type, "text");
  assert.match(last.text!, /response trimmed/);
});

test("mcp: {_tokenomy: 'full'} in tool_input returns passthrough (caller opt-out)", () => {
  const resp: McpToolResponse = {
    content: [{ type: "text", text: makeBlob(5_000) }],
  };
  const r = mcpContentRule(
    "mcp__x__y",
    { _tokenomy: "full", issueKey: "LX-1" },
    resp,
    CFG,
  );
  assert.equal(r.kind, "passthrough");
});

test("mcp: regular call without opt-out still trims", () => {
  const resp: McpToolResponse = {
    content: [{ type: "text", text: makeBlob(5_000) }],
  };
  const r = mcpContentRule("mcp__x__y", { issueKey: "LX-1" }, resp, CFG);
  assert.equal(r.kind, "trim");
});

test("mcp: unprofiled inventory response gets shape-trimmed (not head+tail)", () => {
  // Simulate a tool with no built-in profile that returns a homogeneous
  // {values: [...]} inventory over the default max_text_bytes (200).
  const inventory = {
    values: Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      name: `Thing ${i}`,
      description: "x".repeat(800),
      metadata: { created: "2026-01-01", owner: { name: "A" } },
    })),
  };
  const resp: McpToolResponse = {
    content: [{ type: "text", text: JSON.stringify(inventory) }],
  };
  const r = mcpContentRule("mcp__madeup_tool__listThings", {}, resp, {
    ...CFG,
    mcp: {
      ...CFG.mcp,
      // Input (~35 KB) exceeds this; shape-trim output (~5 KB) fits under it,
      // so shape-trim produces the final result without byte-trim on top.
      max_text_bytes: 16_000,
      shape_trim: { enabled: true, max_items: 50, max_string_bytes: 40 },
    },
  });
  assert.equal(r.kind, "trim");
  if (r.kind !== "trim") return;
  // Reason should reflect shape-trim firing (not +mcp-content-trim).
  assert.equal(r.reason, "shape-trim");
  // The single text block survived as structured JSON (can be parsed back).
  const text = (r.output.content![0] as { text: string }).text;
  const parsed = JSON.parse(text);
  // All 40 rows preserved — not head+tail-sliced.
  assert.equal(parsed.values.length, 40);
  assert.equal(parsed.values[0].id, "0");
  assert.equal(parsed.values[39].id, "39");
});

test("mcp: unknown top-level keys flow through unchanged", () => {
  const resp: McpToolResponse = {
    content: [{ type: "text", text: makeBlob(1_000) }],
    meta: { id: "abc" },
    is_error: true,
  };
  const r = mcpContentRule("mcp__x", {}, resp, CFG);
  assert.equal(r.kind, "trim");
  if (r.kind !== "trim") return;
  assert.deepEqual(r.output.meta, { id: "abc" });
  assert.equal(r.output.is_error, true);
});
