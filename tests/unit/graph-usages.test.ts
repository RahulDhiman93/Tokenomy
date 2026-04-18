import { test } from "node:test";
import assert from "node:assert/strict";
import { findUsages } from "../../src/graph/query/usages.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { Graph } from "../../src/graph/schema.js";

const graph: Graph = {
  schema_version: 1,
  repo_id: "test",
  nodes: [
    { id: "file:src/a.ts", kind: "file", name: "src/a.ts", file: "src/a.ts" },
    { id: "file:src/b.ts", kind: "file", name: "src/b.ts", file: "src/b.ts" },
    { id: "file:src/c.ts", kind: "file", name: "src/c.ts", file: "src/c.ts" },
    {
      id: "sym:src/a.ts#foo@1:0",
      kind: "function",
      name: "foo",
      file: "src/a.ts",
      range: { start: 0, end: 10, line: 1 },
    },
    {
      id: "sym:src/b.ts#callFoo@2:0",
      kind: "function",
      name: "callFoo",
      file: "src/b.ts",
      range: { start: 0, end: 10, line: 2 },
    },
  ],
  edges: [
    { from: "file:src/b.ts", to: "file:src/a.ts", kind: "imports", confidence: "definite" },
    { from: "file:src/c.ts", to: "file:src/a.ts", kind: "imports", confidence: "definite" },
    {
      from: "sym:src/b.ts#callFoo@2:0",
      to: "sym:src/a.ts#foo@1:0",
      kind: "calls",
      confidence: "definite",
    },
  ],
  parse_errors: [],
};

test("find_usages: returns direct importers for a file target", () => {
  const r = findUsages(
    graph,
    { target: { file: "src/a.ts" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id).sort();
  assert.ok(ids.includes("file:src/b.ts"));
  assert.ok(ids.includes("file:src/c.ts"));
});

test("find_usages: returns callers for a symbol target", () => {
  const r = findUsages(
    graph,
    { target: { file: "src/a.ts", symbol: "foo" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id);
  assert.ok(ids.includes("sym:src/b.ts#callFoo@2:0"));
  assert.equal(r.data.focal.name, "foo");
});

test("find_usages: unknown target fails open", () => {
  const r = findUsages(
    graph,
    { target: { file: "src/does-not-exist.ts" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "target-not-found");
});

test("find_usages: summary reports usage count", () => {
  const r = findUsages(
    graph,
    { target: { file: "src/a.ts" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.data.summary, /\d+ usage/);
});
