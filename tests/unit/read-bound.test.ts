import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundRule } from "../../src/rules/read-bound.js";
import type { Config } from "../../src/core/types.js";

const CFG: Config = {
  aggression: "balanced",
  gate: { always_trim_above_bytes: 40_000, min_saved_bytes: 4_000, min_saved_pct: 0.25 },
  mcp: { max_text_bytes: 16_000, per_block_head: 4_000, per_block_tail: 2_000 },
  read: {
    enabled: true,
    clamp_above_bytes: 1_000,
    injected_limit: 100,
    doc_passthrough_extensions: [".md", ".txt"],
    doc_passthrough_max_bytes: 4_000,
  },
  log_path: "/tmp/nope",
  disabled_tools: [],
};

test("read-bound: passthrough when explicit limit given", () => {
  const r = readBoundRule({ file_path: "/tmp/any", limit: 50 }, CFG);
  assert.equal(r.kind, "passthrough");
});

test("read-bound: passthrough when explicit offset given", () => {
  const r = readBoundRule({ file_path: "/tmp/any", offset: 100 }, CFG);
  assert.equal(r.kind, "passthrough");
});

test("read-bound: passthrough when file missing", () => {
  const r = readBoundRule({ file_path: "/tmp/does-not-exist-tokenomy" }, CFG);
  assert.equal(r.kind, "passthrough");
});

test("read-bound: passthrough when file small", () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-read-"));
  try {
    const f = join(dir, "small.txt");
    writeFileSync(f, "tiny");
    const r = readBoundRule({ file_path: f }, CFG);
    assert.equal(r.kind, "passthrough");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-bound: clamps when file exceeds threshold", () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-read-"));
  try {
    const f = join(dir, "big.txt");
    writeFileSync(f, "X".repeat(5_000));
    const r = readBoundRule({ file_path: f }, CFG);
    assert.equal(r.kind, "clamp");
    assert.equal(r.updatedInput!["limit"], 100);
    assert.equal(r.updatedInput!["file_path"], f);
    assert.match(r.additionalContext!, /clamped Read to 100 lines/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-bound: .md under doc cap passthroughs even above clamp threshold", () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-read-"));
  try {
    const f = join(dir, "README.md");
    writeFileSync(f, "X".repeat(2_000));
    const r = readBoundRule({ file_path: f }, CFG);
    assert.equal(r.kind, "passthrough");
    assert.equal(r.reason, "doc-passthrough");
    assert.equal(r.fileBytes, 2_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-bound: .md above doc cap still clamps", () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-read-"));
  try {
    const f = join(dir, "huge.md");
    writeFileSync(f, "X".repeat(8_000));
    const r = readBoundRule({ file_path: f }, CFG);
    assert.equal(r.kind, "clamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-bound: source file extension still clamps above threshold", () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-read-"));
  try {
    const f = join(dir, "code.ts");
    writeFileSync(f, "X".repeat(2_000));
    const r = readBoundRule({ file_path: f }, CFG);
    assert.equal(r.kind, "clamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-bound: .md with explicit limit still passthroughs via explicit-limit branch", () => {
  const r = readBoundRule({ file_path: "/tmp/whatever.md", limit: 50 }, CFG);
  assert.equal(r.kind, "passthrough");
  assert.equal(r.reason, "explicit-limit");
});

test("read-bound: disabled config short-circuits", () => {
  const dir = mkdtempSync(join(tmpdir(), "tok-read-"));
  try {
    const f = join(dir, "big.txt");
    writeFileSync(f, "X".repeat(5_000));
    const r = readBoundRule({ file_path: f }, { ...CFG, read: { ...CFG.read, enabled: false } });
    assert.equal(r.kind, "passthrough");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
