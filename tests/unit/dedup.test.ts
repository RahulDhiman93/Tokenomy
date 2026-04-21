import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAndRecordDuplicate,
  dedupKey,
  duplicateResponseBody,
} from "../../src/core/dedup.js";
import type { Config, HookInput } from "../../src/core/types.js";

const CFG: Config = {
  aggression: "balanced",
  gate: { always_trim_above_bytes: 40_000, min_saved_bytes: 100, min_saved_pct: 0.1 },
  mcp: { max_text_bytes: 2_000, per_block_head: 500, per_block_tail: 200 },
  read: { enabled: true, clamp_above_bytes: 40_000, injected_limit: 500 },
  graph: {
    enabled: false,
    max_files: 10,
    hard_max_files: 20,
    build_timeout_ms: 1_000,
    max_edges_per_file: 10,
    max_snapshot_bytes: 1_000,
    query_budget_bytes: {
      build_or_update_graph: 100,
      get_minimal_context: 100,
      get_impact_radius: 100,
      get_review_context: 100,
      find_usages: 100,
    },
    exclude: [],
  },
  redact: { enabled: true },
  log_path: "/tmp/nope.jsonl",
  disabled_tools: [],
  dedup: { enabled: true, min_bytes: 100, window_seconds: 60 },
};

const makeInput = (session: string, tool: string, args: Record<string, unknown>, body: unknown): HookInput => ({
  session_id: session,
  transcript_path: "/tmp/t",
  cwd: "/tmp",
  permission_mode: "default",
  hook_event_name: "PostToolUse",
  tool_name: tool,
  tool_input: args,
  tool_use_id: "u",
  tool_response: body,
});

// Tests that touch the real ~/.tokenomy ledger would pollute it. Override
// HOME to a sandbox for the duration.
const withSandboxHome = <T>(fn: () => T): T => {
  const tmp = mkdtempSync(join(tmpdir(), "tokenomy-dedup-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tmp;
  try {
    return fn();
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
};

test("dedupKey: stable under argument key reordering", () => {
  const a = dedupKey("mcp__x__y", { a: 1, b: 2, nested: { c: 3, d: 4 } });
  const b = dedupKey("mcp__x__y", { b: 2, a: 1, nested: { d: 4, c: 3 } });
  assert.equal(a, b);
});

test("dedupKey: different tools → different keys", () => {
  assert.notEqual(
    dedupKey("mcp__a__b", { x: 1 }),
    dedupKey("mcp__a__c", { x: 1 }),
  );
});

test("duplicateResponseBody: preserves array shape", () => {
  const dup = duplicateResponseBody([{ type: "text", text: "x" }], 3, "2026-04-18T00:00:00Z");
  assert.ok(Array.isArray(dup));
});

test("duplicateResponseBody: preserves CallToolResult shape and is_error", () => {
  const orig = { content: [{ type: "text", text: "x" }], is_error: true, meta: { id: 1 } };
  const dup = duplicateResponseBody(orig, 2, "2026-04-18T00:00:00Z") as Record<string, unknown>;
  assert.equal(Array.isArray(dup), false);
  assert.equal(dup["is_error"], true);
  assert.deepEqual(dup["meta"], { id: 1 });
  assert.equal(Array.isArray(dup["content"]), true);
});

test("checkAndRecordDuplicate: first call is not a duplicate", () => {
  withSandboxHome(() => {
    const body = { content: [{ type: "text", text: "x".repeat(200) }] };
    const r = checkAndRecordDuplicate(
      makeInput("sess-a", "mcp__a__b", { id: 1 }, body),
      CFG,
    );
    assert.equal(r.duplicate, false);
  });
});

test("checkAndRecordDuplicate: second identical call is a duplicate", () => {
  withSandboxHome(() => {
    const body = { content: [{ type: "text", text: "x".repeat(500) }] };
    const input = makeInput("sess-b", "mcp__a__b", { id: 1 }, body);
    const first = checkAndRecordDuplicate(input, CFG);
    assert.equal(first.duplicate, false);
    const second = checkAndRecordDuplicate(input, CFG);
    assert.equal(second.duplicate, true);
    assert.equal(second.firstIndex, 1);
    assert.ok(second.bytesOut < second.bytesIn);
    const content = (second.stubOutput as { content: { text: string }[] }).content;
    assert.match(content[0]!.text, /duplicate of call #1/);
  });
});

test("checkAndRecordDuplicate: below min_bytes is not dedup'd", () => {
  withSandboxHome(() => {
    const body = { content: [{ type: "text", text: "x" }] };
    const input = makeInput("sess-c", "mcp__a__b", { id: 1 }, body);
    checkAndRecordDuplicate(input, CFG);
    const r = checkAndRecordDuplicate(input, CFG);
    assert.equal(r.duplicate, false);
  });
});

test("checkAndRecordDuplicate: disabled by config", () => {
  withSandboxHome(() => {
    const body = { content: [{ type: "text", text: "x".repeat(500) }] };
    const input = makeInput("sess-d", "mcp__a__b", { id: 1 }, body);
    const noDedup: Config = { ...CFG, dedup: { enabled: false, min_bytes: 0, window_seconds: 60 } };
    checkAndRecordDuplicate(input, noDedup);
    const r = checkAndRecordDuplicate(input, noDedup);
    assert.equal(r.duplicate, false);
  });
});

test("checkAndRecordDuplicate: different sessions don't cross-contaminate", () => {
  withSandboxHome(() => {
    const body = { content: [{ type: "text", text: "x".repeat(500) }] };
    checkAndRecordDuplicate(makeInput("s1", "mcp__a__b", { id: 1 }, body), CFG);
    const r = checkAndRecordDuplicate(makeInput("s2", "mcp__a__b", { id: 1 }, body), CFG);
    assert.equal(r.duplicate, false);
  });
});
