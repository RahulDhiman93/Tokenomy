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

test("graph store: saves and loads graph snapshot + meta (in-repo location)", () => {
  withTempHome((home) => {
    // 0.1.8+: storage lives at `<repoPath>/.tokenomy-graph/`. Use the temp
    // HOME's tmp dir as a stand-in `repoPath` so the in-repo layout writes
    // somewhere we control (and clean up).
    const repoPath = mkdtempSync(join(tmpdir(), "tokenomy-graph-store-repo-"));
    const identity = { repoId: "repo", repoPath };
    try {
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
        repo_path: repoPath,
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

      store.save(identity, graph, meta);
      assert.equal(existsSync(graphSnapshotPath(identity)), true);
      assert.equal(existsSync(graphMetaPath(identity)), true);
      assert.deepEqual(store.loadGraph(identity), graph);
      const loaded = store.loadMeta(identity);
      assert.ok(loaded, "loadMeta must return a value");
      assert.ok(typeof loaded!.snapshot_sha256 === "string", "snapshot_sha256 must be set");
      assert.equal(loaded!.snapshot_sha256!.length, 64);
      const { snapshot_sha256: _sha, ...rest } = loaded!;
      assert.deepEqual(rest, meta);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

test("graph store: legacy 'home' location still works for escape-hatch users", () => {
  withTempHome(() => {
    const identity = { repoId: "repo", repoPath: "/tmp/repo" };
    const cfg = { location: "home" as const };
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
    store.save(identity, graph, meta, cfg);
    assert.equal(existsSync(graphSnapshotPath(identity, cfg)), true);
    assert.equal(existsSync(graphMetaPath(identity, cfg)), true);
    assert.deepEqual(store.loadGraph(identity, cfg), graph);
    const loaded = store.loadMeta(identity, cfg);
    assert.ok(loaded);
    assert.ok(typeof loaded!.snapshot_sha256 === "string");
    const { snapshot_sha256: _sha, ...rest } = loaded!;
    assert.deepEqual(rest, meta);
  });
});
