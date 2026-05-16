import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { impactRadius } from "../../src/graph/query/impact.js";
import { reviewContext } from "../../src/graph/query/review.js";
import { findUsages } from "../../src/graph/query/usages.js";
import { minimalContext } from "../../src/graph/query/minimal.js";
import type { Graph } from "../../src/graph/schema.js";

// 0.1.9+: scoped stale. Every query intersects `stale_files` (whole-graph
// drift) with the files it actually walks. A dirty unrelated file no
// longer flags the answer as stale; only edits to reachable files do.

const buildFixture = (): Graph => ({
  schema_version: 1,
  repo_id: "fixture",
  parse_errors: [],
  nodes: [
    { id: "file:src/lib.ts", kind: "file", name: "lib.ts", file: "src/lib.ts" },
    { id: "file:src/api.ts", kind: "file", name: "api.ts", file: "src/api.ts" },
    { id: "file:src/cli.ts", kind: "file", name: "cli.ts", file: "src/cli.ts" },
    { id: "file:src/unrelated.ts", kind: "file", name: "unrelated.ts", file: "src/unrelated.ts" },
    {
      id: "sym:src/lib.ts:makeRetry",
      kind: "function",
      name: "makeRetry",
      file: "src/lib.ts",
      exported: true,
    },
    {
      id: "sym:src/lib.ts:makeRetry:export",
      kind: "exported-symbol",
      name: "makeRetry",
      file: "src/lib.ts",
    },
    {
      id: "sym:src/api.ts:callApi",
      kind: "function",
      name: "callApi",
      file: "src/api.ts",
      exported: true,
    },
  ],
  edges: [
    { from: "file:src/api.ts", to: "file:src/lib.ts", kind: "imports", confidence: "definite" },
    { from: "file:src/cli.ts", to: "file:src/api.ts", kind: "imports", confidence: "definite" },
    {
      from: "sym:src/api.ts:callApi",
      to: "sym:src/lib.ts:makeRetry",
      kind: "calls",
      confidence: "definite",
    },
    {
      from: "file:src/lib.ts",
      to: "sym:src/lib.ts:makeRetry",
      kind: "contains",
      confidence: "definite",
    },
    {
      from: "file:src/lib.ts",
      to: "sym:src/lib.ts:makeRetry:export",
      kind: "exports",
      confidence: "definite",
    },
  ],
});

test("findUsages: unrelated dirty file keeps stale conservative but in_scope empty", () => {
  // codex round 2 P2: `stale` stays conservative because an edit can
  // introduce new edges that the OLD snapshot doesn't show. Callers
  // use `stale_in_scope` to see whether the drift is known relevant.
  const g = buildFixture();
  const result = findUsages(
    g,
    { target: { file: "src/lib.ts", symbol: "makeRetry" } },
    DEFAULT_CONFIG,
    true,
    ["src/unrelated.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, []);
  assert.deepEqual(result.stale_files, ["src/unrelated.ts"]);
});

test("findUsages: dirty file in reachable surface flags stale", () => {
  const g = buildFixture();
  const result = findUsages(
    g,
    { target: { file: "src/lib.ts", symbol: "makeRetry" } },
    DEFAULT_CONFIG,
    true,
    ["src/api.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, ["src/api.ts"]);
});

test("findUsages: focal file itself dirty flags stale", () => {
  const g = buildFixture();
  const result = findUsages(
    g,
    { target: { file: "src/lib.ts", symbol: "makeRetry" } },
    DEFAULT_CONFIG,
    true,
    ["src/lib.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, ["src/lib.ts"]);
});

test("impactRadius: unrelated dirty file keeps stale conservative, in_scope empty", () => {
  const g = buildFixture();
  const result = impactRadius(
    g,
    { changed: [{ file: "src/lib.ts" }] },
    DEFAULT_CONFIG,
    true,
    ["src/unrelated.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, []);
});

test("impactRadius: dirty transitive importer flags stale", () => {
  const g = buildFixture();
  const result = impactRadius(
    g,
    { changed: [{ file: "src/lib.ts" }] },
    DEFAULT_CONFIG,
    true,
    ["src/cli.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, ["src/cli.ts"]);
});

test("impactRadius: seed file (input.changed) counted in reachable surface", () => {
  const g = buildFixture();
  // Even with no reverse_deps reached (zero-fanout file), the changed
  // input file itself is always in-scope — a dirty mark on it should
  // flag stale because the seed is what the caller's asking about.
  const result = impactRadius(
    g,
    { changed: [{ file: "src/lib.ts" }] },
    DEFAULT_CONFIG,
    true,
    ["src/lib.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, ["src/lib.ts"]);
});

test("minimalContext: unrelated dirty file keeps stale conservative, in_scope empty", () => {
  const g = buildFixture();
  const result = minimalContext(
    g,
    { target: { file: "src/lib.ts", symbol: "makeRetry" } },
    DEFAULT_CONFIG,
    true,
    ["src/unrelated.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, []);
});

test("minimalContext: dirty neighbor file flags stale", () => {
  const g = buildFixture();
  const result = minimalContext(
    g,
    { target: { file: "src/lib.ts", symbol: "makeRetry" } },
    DEFAULT_CONFIG,
    true,
    ["src/api.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, ["src/api.ts"]);
});

test("reviewContext: unrelated dirty file keeps stale conservative, in_scope empty", () => {
  const g = buildFixture();
  const result = reviewContext(
    g,
    { files: ["src/lib.ts"] },
    DEFAULT_CONFIG,
    true,
    ["src/unrelated.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, []);
});

test("reviewContext: dirty changed-file flags stale", () => {
  const g = buildFixture();
  const result = reviewContext(
    g,
    { files: ["src/lib.ts"] },
    DEFAULT_CONFIG,
    true,
    ["src/lib.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, ["src/lib.ts"]);
});

test("reviewContext: dirty fanout importer flags stale", () => {
  const g = buildFixture();
  const result = reviewContext(
    g,
    { files: ["src/lib.ts"] },
    DEFAULT_CONFIG,
    true,
    ["src/api.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, ["src/api.ts"]);
});

test("scopeStale: empty stale_files short-circuits to stale: false", () => {
  const g = buildFixture();
  const result = findUsages(
    g,
    { target: { file: "src/lib.ts", symbol: "makeRetry" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, false);
  assert.deepEqual(result.stale_in_scope, []);
  assert.deepEqual(result.stale_files, []);
});

test("scopeStale: whole-graph invalidation preserves stale flag (codex round 3 P2)", () => {
  // getGraphStaleStatus returns { stale: true, stale_files: [] } when
  // exclude_fingerprint or tsconfig_fingerprint changes (whole-graph
  // invalidation; no granular drift list). Queries must honor the
  // input stale flag even when stale_files is empty.
  const g = buildFixture();
  const result = findUsages(
    g,
    { target: { file: "src/lib.ts", symbol: "makeRetry" } },
    DEFAULT_CONFIG,
    true,
    [],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, []);
  // codex round 9 P2: whole_graph_stale set distinguishes "every
  // query affected" from "unrelated drift" (both have empty
  // stale_in_scope).
  assert.equal(result.whole_graph_stale, true);
});

test("findUsages: unrelated drift does NOT set whole_graph_stale (codex round 9 P2)", () => {
  const g = buildFixture();
  const result = findUsages(
    g,
    { target: { file: "src/lib.ts", symbol: "makeRetry" } },
    DEFAULT_CONFIG,
    true,
    ["src/unrelated.ts"],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.stale, true);
  assert.deepEqual(result.stale_in_scope, []);
  // Unrelated drift → whole_graph_stale is NOT set.
  assert.equal(result.whole_graph_stale, undefined);
});
