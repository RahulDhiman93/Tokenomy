import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graphMetaPath, graphSnapshotPath } from "../../src/core/paths.js";
import { GRAPH_SCHEMA_VERSION, type Graph, type GraphMeta } from "../../src/graph/schema.js";
import { JsonGraphStore } from "../../src/graph/store.js";

const withTempHome = (fn: (home: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-graph-store-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
};

test("graph store: saves and loads graph snapshot + meta atomically", () => {
  withTempHome(() => {
    const store = new JsonGraphStore();
    const graph: Graph = {
      schema_version: GRAPH_SCHEMA_VERSION,
      repo_id: "repo",
      nodes: [{ id: "file:src/a.ts", kind: "file", name: "src/a.ts", file: "src/a.ts" }],
      edges: [],
      parse_errors: [],
    };
    const meta: GraphMeta = {
      schema_version: GRAPH_SCHEMA_VERSION,
      repo_id: "repo",
      repo_path: "/tmp/repo",
      built_at: "2026-04-17T00:00:00.000Z",
      tokenomy_version: "0.1.0-alpha.4",
      node_count: 1,
      edge_count: 0,
      file_hashes: { "src/a.ts": "abc" },
      file_mtimes: { "src/a.ts": 1 },
      soft_cap: 2_000,
      hard_cap: 5_000,
      parse_error_count: 0,
    };

    store.save("repo", graph, meta);
    assert.equal(existsSync(graphSnapshotPath("repo")), true);
    assert.equal(existsSync(graphMetaPath("repo")), true);
    assert.deepEqual(store.loadGraph("repo"), graph);
    assert.deepEqual(store.loadMeta("repo"), meta);
  });
});
