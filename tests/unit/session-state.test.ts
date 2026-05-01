import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionState, updateSessionState } from "../../src/core/session-state.js";
import { sessionStatePath, sessionStateSlug, sessionStateDir } from "../../src/core/paths.js";

const setupHome = () => {
  const dir = join(
    tmpdir(),
    `tokenomy-ss-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  const prev = process.env["HOME"];
  process.env["HOME"] = dir;
  return {
    home: dir,
    restore: () => {
      if (prev === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prev;
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("sessionStatePath: hashed filename; path-traversal session_id is sanitized", () => {
  const p1 = sessionStatePath("../../evil");
  const p2 = sessionStatePath("also-evil/../../else");
  assert.ok(p1.endsWith(".ndjson"));
  assert.ok(p2.endsWith(".ndjson"));
  // No "/" or ".." after the session dir.
  const base = sessionStateDir();
  assert.ok(p1.startsWith(base + "/"));
  assert.ok(p2.startsWith(base + "/"));
  assert.ok(!p1.includes("/.."));
  assert.ok(!p2.includes("/.."));
  // Deterministic.
  assert.equal(sessionStateSlug("abc"), sessionStateSlug("abc"));
  // Different ids → different slugs.
  assert.notEqual(sessionStateSlug("a"), sessionStateSlug("b"));
});

test("updateSessionState: append-only ledger never loses increments (race-safe)", () => {
  const h = setupHome();
  try {
    // Simulate 50 concurrent-ish writes all on the same session.
    for (let i = 0; i < 50; i++) updateSessionState("s-race", 10, "Bash");
    const state = readSessionState("s-race");
    assert.ok(state);
    assert.equal(state!.running_estimated_tokens, 500);
    // recent view bounded.
    assert.ok(state!.recent.length <= 200);
  } finally {
    h.restore();
  }
});

test("readSessionState: tail-only read on a >256KB ledger", () => {
  const h = setupHome();
  try {
    const sid = "huge-sid";
    const path = sessionStatePath(sid);
    mkdirSync(sessionStateDir(), { recursive: true });
    // Build ~1 MB of valid JSONL entries — readLedger should tail-read
    // the last 256 KB only and still produce a sensible aggregate.
    const lines: string[] = [];
    for (let i = 0; i < 12_000; i++) {
      lines.push(JSON.stringify({ ts: `2026-04-30T00:00:${(i % 60).toString().padStart(2, "0")}Z`, tool: "Bash", tokens: 1 }));
    }
    writeFileSync(path, lines.join("\n") + "\n", "utf8");
    const state = readSessionState(sid);
    assert.ok(state);
    // Tail-only read: total reflects the ~last-N entries that fit in 256KB.
    assert.ok(state!.running_estimated_tokens > 0);
    assert.ok(state!.running_estimated_tokens < 12_000, "tail read must drop earlier entries");
  } finally {
    h.restore();
  }
});

test("readSessionState: missing file returns null", () => {
  const h = setupHome();
  try {
    assert.equal(readSessionState("never-touched-sid"), null);
  } finally {
    h.restore();
  }
});

test("updateSessionState: prunes files older than TTL", () => {
  const h = setupHome();
  try {
    // Seed a stale file with mtime 3 days ago.
    const stalePath = sessionStatePath("stale-sid");
    mkdirSync(sessionStateDir(), { recursive: true });
    writeFileSync(stalePath, '{"ts":"old","tool":"x","tokens":1}\n', "utf8");
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(stalePath, threeDaysAgo, threeDaysAgo);
    assert.ok(existsSync(stalePath));
    // Any update triggers prune.
    updateSessionState("fresh-sid", 5, "Bash");
    assert.equal(existsSync(stalePath), false, "stale file should be pruned");
  } finally {
    h.restore();
  }
});
