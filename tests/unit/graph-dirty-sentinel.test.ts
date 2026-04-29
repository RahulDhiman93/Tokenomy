import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markGraphDirty } from "../../src/rules/graph-dirty.js";
import { isGraphStaleCheap } from "../../src/graph/stale.js";
import { graphDir, graphDirtySentinelPath, graphMetaPath, graphSnapshotPath } from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { Config, HookInput } from "../../src/core/types.js";

const cfgWithGraph = (): Config => ({
  ...(structuredClone(DEFAULT_CONFIG) as Config),
});

const withTmpHomeAndRepo = <T>(fn: (home: string, repo: string) => T): T => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-graph-dirty-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-graph-dirty-repo-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return fn(home, repo);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
};

const baseInput = (cwd: string, tool: string, file: string): HookInput => ({
  session_id: "s",
  transcript_path: "/t",
  cwd,
  permission_mode: "acceptEdits",
  hook_event_name: "PostToolUse",
  tool_name: tool,
  tool_input: { file_path: file },
  tool_use_id: "id",
  tool_response: null,
});

test("markGraphDirty: writes .dirty sentinel for Edit on a repo with an existing graph dir", () => {
  withTmpHomeAndRepo((home, repo) => {
    // Pretend a graph snapshot exists for this repo so the rule fires.
    const { repoId } = resolveRepoId(repo);
    mkdirSync(graphDir(repoId), { recursive: true });
    markGraphDirty(baseInput(repo, "Edit", "src/a.ts"), cfgWithGraph());
    const sentinel = graphDirtySentinelPath(repoId);
    assert.ok(existsSync(sentinel), "expected .dirty sentinel to exist");
    const body = readFileSync(sentinel, "utf8");
    assert.match(body, /src\/a\.ts/);
    void home;
  });
});

test("markGraphDirty: idempotent / appends across multiple edits", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const { repoId } = resolveRepoId(repo);
    mkdirSync(graphDir(repoId), { recursive: true });
    markGraphDirty(baseInput(repo, "Write", "src/a.ts"), cfgWithGraph());
    markGraphDirty(baseInput(repo, "Edit", "src/b.ts"), cfgWithGraph());
    markGraphDirty(baseInput(repo, "MultiEdit", "src/c.ts"), cfgWithGraph());
    const body = readFileSync(graphDirtySentinelPath(repoId), "utf8").split("\n").filter(Boolean);
    assert.equal(body.length, 3);
  });
});

test("markGraphDirty: skips when graph dir does not exist (no graph built for this repo)", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const { repoId } = resolveRepoId(repo);
    markGraphDirty(baseInput(repo, "Edit", "src/a.ts"), cfgWithGraph());
    // Should NOT auto-create the graph dir or sentinel.
    assert.equal(existsSync(graphDir(repoId)), false);
    assert.equal(existsSync(graphDirtySentinelPath(repoId)), false);
  });
});

test("markGraphDirty: skips when cfg.graph.enabled is false", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const { repoId } = resolveRepoId(repo);
    mkdirSync(graphDir(repoId), { recursive: true });
    const cfg = cfgWithGraph();
    cfg.graph.enabled = false;
    markGraphDirty(baseInput(repo, "Edit", "src/a.ts"), cfg);
    assert.equal(existsSync(graphDirtySentinelPath(repoId)), false);
  });
});

test("markGraphDirty: skips for non-edit tool names", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const { repoId } = resolveRepoId(repo);
    mkdirSync(graphDir(repoId), { recursive: true });
    markGraphDirty(baseInput(repo, "Read", "src/a.ts"), cfgWithGraph());
    markGraphDirty(baseInput(repo, "Bash", ""), cfgWithGraph());
    assert.equal(existsSync(graphDirtySentinelPath(repoId)), false);
  });
});

test("isGraphStaleCheap: short-circuits to stale when sentinel exists", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const { repoId } = resolveRepoId(repo);
    // Fake a built graph: write minimal meta + snapshot files so the check
    // doesn't bail with "missing".
    mkdirSync(graphDir(repoId), { recursive: true });
    writeFileSync(
      graphMetaPath(repoId),
      JSON.stringify({
        schema_version: 1,
        repo_id: repoId,
        repo_path: repo,
        built_at: new Date().toISOString(),
        tokenomy_version: "0.1.3",
        node_count: 0,
        edge_count: 0,
        file_hashes: {},
        file_mtimes: {},
        soft_cap: 1000,
        hard_cap: 5000,
        parse_error_count: 0,
      }),
    );
    writeFileSync(graphSnapshotPath(repoId), JSON.stringify({ schema_version: 1, repo_id: repoId, nodes: [], edges: [], parse_errors: [] }));
    // Drop the sentinel.
    writeFileSync(graphDirtySentinelPath(repoId), "marked\n");
    const result = isGraphStaleCheap(repo, cfgWithGraph());
    assert.equal(result.missing, false);
    assert.equal(result.stale, true);
    // Short-circuit: stale_files is empty since we didn't enumerate.
    assert.deepEqual(result.stale_files, []);
  });
});
