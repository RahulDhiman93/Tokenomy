import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { impactRadius } from "../../src/graph/query/impact.js";
import { reviewContext } from "../../src/graph/query/review.js";
import { findUsages } from "../../src/graph/query/usages.js";
import type { Graph } from "../../src/graph/schema.js";

// Hand-built fixture graph. Three source files import each other and a test
// file paired by name with src/lib.ts:
//
//   src/lib.ts       (function: makeRetry, exported)
//   src/api.ts       imports src/lib.ts, calls makeRetry
//   src/cli.ts       imports src/api.ts
//   tests/lib.test.ts (test-file paired by name with lib.ts)
const buildFixture = (): Graph => {
  return {
    schema_version: 1,
    repo_id: "fixture",
    parse_errors: [],
    nodes: [
      { id: "file:src/lib.ts", kind: "file", name: "lib.ts", file: "src/lib.ts" },
      { id: "file:src/api.ts", kind: "file", name: "api.ts", file: "src/api.ts" },
      { id: "file:src/cli.ts", kind: "file", name: "cli.ts", file: "src/cli.ts" },
      {
        id: "file:tests/lib.test.ts",
        kind: "test-file",
        name: "lib.test.ts",
        file: "tests/lib.test.ts",
      },
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
      // imports
      { from: "file:src/api.ts", to: "file:src/lib.ts", kind: "imports", confidence: "definite" },
      { from: "file:src/cli.ts", to: "file:src/api.ts", kind: "imports", confidence: "definite" },
      // calls — api.ts.callApi calls lib.ts.makeRetry
      {
        from: "sym:src/api.ts:callApi",
        to: "sym:src/lib.ts:makeRetry",
        kind: "calls",
        confidence: "definite",
      },
      // contains
      {
        from: "file:src/lib.ts",
        to: "sym:src/lib.ts:makeRetry",
        kind: "contains",
        confidence: "definite",
      },
      {
        from: "file:src/lib.ts",
        to: "sym:src/lib.ts:makeRetry:export",
        kind: "contains",
        confidence: "definite",
      },
      // exports
      {
        from: "file:src/lib.ts",
        to: "sym:src/lib.ts:makeRetry:export",
        kind: "exports",
        confidence: "definite",
      },
      // tests-pairs
      {
        from: "file:tests/lib.test.ts",
        to: "file:src/lib.ts",
        kind: "tests",
        confidence: "definite",
      },
    ],
  };
};

test("impactRadius: returns reverse-deps + suggested-tests for a changed file", () => {
  const g = buildFixture();
  const result = impactRadius(
    g,
    { changed: [{ file: "src/lib.ts" }] },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  // src/lib.ts is imported by src/api.ts which is imported by src/cli.ts → 2 reverse deps.
  const files = result.data.reverse_deps.map((d) => d.file).filter(Boolean) as string[];
  assert.ok(files.includes("src/api.ts"), JSON.stringify(files));
  assert.ok(files.includes("src/cli.ts"), JSON.stringify(files));
  // suggested_tests only fires for *reached* files, not the seed. The seed is
  // src/lib.ts and tests/lib.test.ts pairs with it by basename — but pairing
  // is checked against reverse-deps (api.ts, cli.ts), not the seed. So this
  // particular fixture exercises the "no test pairing" branch.
  assert.deepEqual(result.data.suggested_tests, []);
  assert.match(result.data.summary, /reverse deps: \d+/);
});

test("impactRadius: target-not-found when changed file isn't in the graph", () => {
  const g = buildFixture();
  const result = impactRadius(
    g,
    { changed: [{ file: "src/does-not-exist.ts" }] },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "target-not-found");
});

test("impactRadius: max_depth=1 prunes transitive reverse-deps", () => {
  const g = buildFixture();
  const result = impactRadius(
    g,
    { changed: [{ file: "src/lib.ts" }], max_depth: 1 },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const files = result.data.reverse_deps.map((d) => d.file);
  // Only the direct importer should be returned; cli.ts is depth 2.
  assert.ok(files.includes("src/api.ts"));
  assert.ok(!files.includes("src/cli.ts"), JSON.stringify(files));
});

test("impactRadius: per-symbol changed list resolves the symbol's reverse-deps", () => {
  const g = buildFixture();
  const result = impactRadius(
    g,
    { changed: [{ file: "src/lib.ts", symbols: ["makeRetry"] }] },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  // callApi calls makeRetry — should appear as reverse dep at depth 1.
  assert.ok(result.data.reverse_deps.some((d) => d.id === "sym:src/api.ts:callApi"));
});

test("reviewContext: ranks hotspots by imports-in + calls-in", () => {
  const g = buildFixture();
  const result = reviewContext(
    g,
    { files: ["src/lib.ts", "src/api.ts"] },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.changed_files, ["src/api.ts", "src/lib.ts"]);
  assert.equal(result.data.exports_touched, 1); // makeRetry export
  assert.ok(result.data.hotspots.length >= 1);
  const top = result.data.hotspots[0]!;
  // src/lib.ts has 1 import-in (from api.ts) + 1 call-in (makeRetry called by callApi)
  // src/api.ts has 1 import-in (from cli.ts) + 0 call-ins → lib.ts ranks first.
  assert.equal(top.file, "src/lib.ts");
  assert.equal(top.score >= 1, true);
});

test("reviewContext: target-not-found when no input files match the graph", () => {
  const g = buildFixture();
  const result = reviewContext(
    g,
    { files: ["nonexistent/path.ts"] },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "target-not-found");
});

test("reviewContext: fanout_summary surfaces imports + imported_by per file", () => {
  const g = buildFixture();
  const result = reviewContext(
    g,
    { files: ["src/api.ts"] },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const apiRow = result.data.fanout_summary.find((r) => r.file === "src/api.ts")!;
  assert.equal(apiRow.imports, 1); // imports lib.ts
  assert.equal(apiRow.imported_by, 1); // imported by cli.ts
});

test("findUsages: makeRetry surfaces api.callApi as a call-site", () => {
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
  assert.equal(result.data.focal.name, "makeRetry");
  // callApi → makeRetry edge becomes one call_site row.
  const ids = result.data.call_sites.map((c) => c.id);
  assert.ok(
    ids.includes("sym:src/api.ts:callApi"),
    `expected api.callApi in call_sites, got ${JSON.stringify(ids)}`,
  );
  assert.match(result.data.summary, /usage\(s\) of makeRetry/);
});

test("findUsages: returns target-not-found for unknown file", () => {
  const g = buildFixture();
  const result = findUsages(
    g,
    { target: { file: "src/nope.ts" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(result.ok, false);
});
