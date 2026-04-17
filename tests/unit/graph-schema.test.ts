import { test } from "node:test";
import assert from "node:assert/strict";
import { stableStringify } from "../../src/util/json.js";
import { GRAPH_SCHEMA_VERSION, normalizeGraph } from "../../src/graph/schema.js";

test("graph schema: normalizeGraph sorts and dedupes deterministically", () => {
  const graph = normalizeGraph({
    schema_version: GRAPH_SCHEMA_VERSION,
    repo_id: "repo",
    nodes: [
      { id: "file:src/b.ts", kind: "file", name: "src/b.ts", file: "src/b.ts" },
      { id: "file:src/a.ts", kind: "file", name: "src/a.ts", file: "src/a.ts" },
      { id: "file:src/a.ts", kind: "file", name: "src/a.ts", file: "src/a.ts" },
    ],
    edges: [
      { from: "file:src/b.ts", to: "file:src/a.ts", kind: "imports", confidence: "definite" },
      { from: "file:src/b.ts", to: "file:src/a.ts", kind: "imports", confidence: "definite" },
      { from: "file:src/a.ts", to: "file:src/b.ts", kind: "imports", confidence: "inferred" },
    ],
    parse_errors: [
      { file: "src/z.ts", message: "later" },
      { file: "src/a.ts", message: "first" },
      { file: "src/a.ts", message: "first" },
    ],
  });

  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    ["file:src/a.ts", "file:src/b.ts"],
  );
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.from}->${edge.to}:${edge.confidence}`),
    [
      "file:src/a.ts->file:src/b.ts:inferred",
      "file:src/b.ts->file:src/a.ts:definite",
    ],
  );
  assert.deepEqual(graph.parse_errors, [
    { file: "src/a.ts", message: "first" },
    { file: "src/z.ts", message: "later" },
  ]);
  assert.match(stableStringify(graph), /"repo_id": "repo"/);
});
