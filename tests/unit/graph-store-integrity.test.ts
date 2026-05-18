import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  graphCorruptDir,
  graphIntegrityStatsPath,
  graphMetaPath,
  graphSnapshotPath,
  graphCommitTempDir,
  graphDir,
} from "../../src/core/paths.js";
import { GRAPH_SCHEMA_VERSION, type Graph, type GraphMeta } from "../../src/graph/schema.js";
import { JsonGraphStore } from "../../src/graph/store.js";

const withRepo = (fn: (repoPath: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-integ-home-"));
  const repoPath = mkdtempSync(join(tmpdir(), "tokenomy-integ-repo-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    fn(repoPath);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
  }
};

const fixtureGraph = (): Graph => ({
  schema_version: GRAPH_SCHEMA_VERSION,
  repo_id: "repo",
  nodes: [{ id: "file:src/a.ts", kind: "file", name: "src/a.ts", file: "src/a.ts" }],
  edges: [],
  parse_errors: [],
});

const fixtureMeta = (repoPath: string): GraphMeta => ({
  schema_version: GRAPH_SCHEMA_VERSION,
  repo_id: "repo",
  repo_path: repoPath,
  built_at: "2026-05-16T00:00:00.000Z",
  tokenomy_version: "0.1.10",
  node_count: 1,
  edge_count: 0,
  file_hashes: { "src/a.ts": "abc" },
  file_mtimes: { "src/a.ts": 1 },
  soft_cap: 2_000,
  hard_cap: 5_000,
  parse_error_count: 0,
});

test("integrity: stores snapshot_sha256 in meta on save", () => {
  withRepo((repoPath) => {
    const identity = { repoId: "repo", repoPath };
    const store = new JsonGraphStore();
    store.save(identity, fixtureGraph(), fixtureMeta(repoPath));
    const meta = store.loadMeta(identity);
    assert.ok(meta);
    assert.ok(meta!.snapshot_sha256);
    assert.equal(meta!.snapshot_sha256!.length, 64);
  });
});

test("integrity: bumps verified counter on clean load", () => {
  withRepo((repoPath) => {
    const identity = { repoId: "repo", repoPath };
    const store = new JsonGraphStore();
    store.save(identity, fixtureGraph(), fixtureMeta(repoPath));
    store.loadGraph(identity);
    const integ = JSON.parse(readFileSync(graphIntegrityStatsPath(identity), "utf8")) as {
      verified: number;
      mismatched: number;
    };
    assert.equal(integ.verified, 1);
    assert.equal(integ.mismatched, 0);
  });
});

test("integrity: tampered snapshot is quarantined + load returns null", () => {
  withRepo((repoPath) => {
    const identity = { repoId: "repo", repoPath };
    const store = new JsonGraphStore();
    store.save(identity, fixtureGraph(), fixtureMeta(repoPath));
    // Tamper: rewrite snapshot bytes
    const snapPath = graphSnapshotPath(identity);
    writeFileSync(
      snapPath,
      JSON.stringify({
        schema_version: GRAPH_SCHEMA_VERSION,
        repo_id: "repo",
        nodes: [],
        edges: [],
        parse_errors: [],
      }) + "\n",
    );
    const loaded = store.loadGraph(identity);
    assert.equal(loaded, null);
    // Quarantine dir should exist with the corrupt files
    const corruptRoot = graphCorruptDir(identity);
    assert.ok(existsSync(corruptRoot));
    const entries = readdirSync(corruptRoot);
    assert.equal(entries.length, 1);
    const corruptInner = join(corruptRoot, entries[0]!);
    assert.ok(existsSync(join(corruptInner, "snapshot.json")));
    assert.ok(existsSync(join(corruptInner, "reason.txt")));
    const integ = JSON.parse(readFileSync(graphIntegrityStatsPath(identity), "utf8")) as {
      mismatched: number;
      quarantined_total: number;
      last_quarantine_at: string | null;
    };
    assert.equal(integ.mismatched, 1);
    assert.equal(integ.quarantined_total, 1);
    assert.ok(integ.last_quarantine_at);
  });
});

test("integrity: cross-repo meta (repo_id mismatch) is quarantined", () => {
  withRepo((repoPath) => {
    const identityA = { repoId: "repo-A", repoPath };
    const identityB = { repoId: "repo-B", repoPath };
    const store = new JsonGraphStore();
    const g = fixtureGraph();
    g.repo_id = "repo-A";
    const m = fixtureMeta(repoPath);
    m.repo_id = "repo-A";
    store.save(identityA, g, m);
    // Now read as identity B (simulating .tokenomy-graph copied between repos)
    const loaded = store.loadMeta(identityB);
    assert.equal(loaded, null);
    const corruptRoot = graphCorruptDir(identityB);
    assert.ok(existsSync(corruptRoot));
    const entries = readdirSync(corruptRoot);
    assert.equal(entries.length, 1);
    const reason = readFileSync(
      join(corruptRoot, entries[0]!, "reason.txt"),
      "utf8",
    );
    assert.match(reason, /meta-repo-id-mismatch/);
  });
});

test("integrity: pre-0.1.10 meta (no snapshot_sha256) loads without quarantine", () => {
  withRepo((repoPath) => {
    const identity = { repoId: "repo", repoPath };
    const dir = graphDir(identity);
    mkdirSync(dir, { recursive: true });
    // Hand-craft a pre-0.1.10 pair: meta WITHOUT snapshot_sha256.
    const graph = fixtureGraph();
    writeFileSync(graphSnapshotPath(identity), JSON.stringify(graph) + "\n");
    const meta = fixtureMeta(repoPath);
    writeFileSync(graphMetaPath(identity), JSON.stringify(meta) + "\n");
    const store = new JsonGraphStore();
    const loadedGraph = store.loadGraph(identity);
    assert.ok(loadedGraph);
    assert.deepEqual(loadedGraph, graph);
    // No quarantine — pre-0.1.10 just rebuilds on first 0.1.10 invocation,
    // it doesn't pollute the corrupt dir.
    assert.equal(existsSync(graphCorruptDir(identity)), false);
  });
});

test("integrity: orphan commit-<dead-pid> dir is swept on next save", () => {
  withRepo((repoPath) => {
    const identity = { repoId: "repo", repoPath };
    const dir = graphDir(identity);
    mkdirSync(dir, { recursive: true });
    // Drop a dead-pid orphan. PID 1 is alive on most systems; use a
    // very-high pid number that's effectively never alive. (POSIX max pid
    // is typically 4_194_304 — 9_999_999 is safe.)
    const deadPid = 9_999_999;
    const orphan = graphCommitTempDir(identity, undefined, deadPid, "deadbeef");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "snapshot.json"), "{}");
    const store = new JsonGraphStore();
    store.save(identity, fixtureGraph(), fixtureMeta(repoPath));
    // Orphan must be gone after the save's sweep.
    assert.equal(existsSync(orphan), false);
  });
});

test("integrity: own-pid in-flight commit dir is NOT swept", () => {
  withRepo((repoPath) => {
    const identity = { repoId: "repo", repoPath };
    const dir = graphDir(identity);
    mkdirSync(dir, { recursive: true });
    // A live-pid (our own) dir must survive — represents an in-flight
    // build by us. Without this guard we'd race-delete our own commit.
    const ours = graphCommitTempDir(identity, undefined, process.pid, "live");
    mkdirSync(ours, { recursive: true });
    const store = new JsonGraphStore();
    store.save(identity, fixtureGraph(), fixtureMeta(repoPath));
    assert.equal(existsSync(ours), true);
    rmSync(ours, { recursive: true, force: true });
  });
});

test("integrity: schema_version below MIN is quarantined", () => {
  withRepo((repoPath) => {
    const identity = { repoId: "repo", repoPath };
    const dir = graphDir(identity);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      graphSnapshotPath(identity),
      JSON.stringify({
        schema_version: 0,
        repo_id: "repo",
        nodes: [],
        edges: [],
        parse_errors: [],
      }) + "\n",
    );
    writeFileSync(
      graphMetaPath(identity),
      JSON.stringify({ ...fixtureMeta(repoPath), schema_version: 0 }) + "\n",
    );
    const store = new JsonGraphStore();
    assert.equal(store.loadGraph(identity), null);
    assert.ok(existsSync(graphCorruptDir(identity)));
  });
});

test("integrity: schema_version above MAX_KNOWN logs warn and attempts parse", () => {
  withRepo((repoPath) => {
    const identity = { repoId: "repo", repoPath };
    const dir = graphDir(identity);
    mkdirSync(dir, { recursive: true });
    const graph = { ...fixtureGraph(), schema_version: 999 };
    writeFileSync(graphSnapshotPath(identity), JSON.stringify(graph) + "\n");
    // capture stderr
    const realWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as unknown as { write: (s: string | Uint8Array) => boolean }).write = (
      s: string | Uint8Array,
    ): boolean => {
      captured += typeof s === "string" ? s : Buffer.from(s).toString();
      return true;
    };
    try {
      const store = new JsonGraphStore();
      const loaded = store.loadGraph(identity);
      assert.ok(loaded, "future-version snapshot still parses");
      assert.match(captured, /schema_version=999 > max known/);
    } finally {
      process.stderr.write = realWrite;
    }
  });
});
