import { test } from "node:test";
import assert from "node:assert/strict";
import { GRAPH_SCHEMA_VERSION, type GraphMeta } from "../../src/graph/schema.js";
import { fileLooksUnchanged } from "../../src/graph/stale.js";

const baseMeta = (extra: Partial<GraphMeta> = {}): GraphMeta => ({
  schema_version: GRAPH_SCHEMA_VERSION,
  repo_id: "repo",
  repo_path: "/tmp/repo",
  built_at: "2026-05-16T00:00:00.000Z",
  tokenomy_version: "0.1.10",
  node_count: 0,
  edge_count: 0,
  file_hashes: { "a.ts": "h" },
  file_mtimes: { "a.ts": 100 },
  soft_cap: 2_000,
  hard_cap: 5_000,
  parse_error_count: 0,
  ...extra,
});

test("fileLooksUnchanged: matching mtime + size + ino → unchanged", () => {
  const meta = baseMeta({
    file_sizes: { "a.ts": 20 },
    file_inos: { "a.ts": 42 },
  });
  assert.equal(
    fileLooksUnchanged(meta, "a.ts", { ino: 42, mtimeMs: 100, size: 20 }),
    true,
  );
});

test("fileLooksUnchanged: equal mtime but different size → drift (touch -r grow)", () => {
  const meta = baseMeta({
    file_sizes: { "a.ts": 20 },
    file_inos: { "a.ts": 42 },
  });
  assert.equal(
    fileLooksUnchanged(meta, "a.ts", { ino: 42, mtimeMs: 100, size: 25 }),
    false,
  );
});

test("fileLooksUnchanged: equal mtime + size but different inode → drift (rotation/replace)", () => {
  const meta = baseMeta({
    file_sizes: { "a.ts": 20 },
    file_inos: { "a.ts": 42 },
  });
  assert.equal(
    fileLooksUnchanged(meta, "a.ts", { ino: 7, mtimeMs: 100, size: 20 }),
    false,
  );
});

test("fileLooksUnchanged: pre-0.1.10 meta (no sizes/inos) → mtime-only equality", () => {
  const meta = baseMeta();
  // size and ino can be anything; only mtime matters when meta omits them
  assert.equal(
    fileLooksUnchanged(meta, "a.ts", { ino: 9, mtimeMs: 100, size: 999 }),
    true,
  );
  assert.equal(
    fileLooksUnchanged(meta, "a.ts", { ino: 9, mtimeMs: 101, size: 20 }),
    false,
  );
});

test("fileLooksUnchanged: partial meta (sizes present, inos missing) honors size only", () => {
  const meta = baseMeta({ file_sizes: { "a.ts": 20 } });
  assert.equal(
    fileLooksUnchanged(meta, "a.ts", { ino: 1, mtimeMs: 100, size: 20 }),
    true,
  );
  assert.equal(
    fileLooksUnchanged(meta, "a.ts", { ino: 1, mtimeMs: 100, size: 21 }),
    false,
  );
});

test("fileLooksUnchanged: meta has sizes map but missing for this file → falls through (mtime only)", () => {
  const meta = baseMeta({ file_sizes: {} });
  // file_sizes is defined but doesn't carry an entry for "a.ts" → guard
  // skips the size check for this file
  assert.equal(
    fileLooksUnchanged(meta, "a.ts", { ino: 1, mtimeMs: 100, size: 999 }),
    true,
  );
});
