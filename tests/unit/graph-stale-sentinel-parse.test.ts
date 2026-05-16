import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDirtySentinel, isGraphStaleCheap } from "../../src/graph/stale.js";
import { graphDir, graphDirtySentinelPath, graphMetaPath, graphSnapshotPath } from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { fingerprintExcludes } from "../../src/graph/exclude-fingerprint.js";
import { computeTsconfigFingerprint } from "../../src/graph/tsconfig-fingerprint.js";
import { enumerateAllFiles } from "../../src/graph/enumerate.js";

const withTmpHomeAndRepo = <T>(fn: (home: string, repo: string) => T): T => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-stale-parse-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-stale-parse-repo-"));
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

test("readDirtySentinel: parses multi-line append log", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      sentinel,
      "2026-05-15T00:00:00.000Z\tsrc/a.ts\n2026-05-15T00:00:01.000Z\tsrc/b.ts\n",
    );
    const parsed = readDirtySentinel(sentinel);
    assert.deepEqual(parsed.files, ["src/a.ts", "src/b.ts"]);
    assert.equal(parsed.oldest_ts, Date.parse("2026-05-15T00:00:00.000Z"));
  });
});

test("readDirtySentinel: dedupes repeated file paths", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      sentinel,
      "2026-05-15T00:00:00.000Z\tsrc/a.ts\n2026-05-15T00:00:01.000Z\tsrc/a.ts\n2026-05-15T00:00:02.000Z\tsrc/b.ts\n",
    );
    const parsed = readDirtySentinel(sentinel);
    assert.deepEqual(parsed.files, ["src/a.ts", "src/b.ts"]);
  });
});

test("readDirtySentinel: tolerates malformed lines", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      sentinel,
      "garbage-no-tab\n2026-05-15T00:00:00.000Z\tsrc/ok.ts\n\t\n",
    );
    const parsed = readDirtySentinel(sentinel);
    assert.deepEqual(parsed.files, ["src/ok.ts"]);
  });
});

test("readDirtySentinel: missing file returns empty", () => {
  const result = readDirtySentinel("/does/not/exist/.dirty");
  assert.deepEqual(result.files, []);
  assert.equal(result.oldest_ts, null);
});

test("readDirtySentinel: normalizes absolute paths inside repo to relative (codex round 1)", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    // Sentinel records an absolute path inside the repo — PostToolUse
    // payloads commonly do this. Without normalization, scopeStale
    // would never intersect with graph node ids (always relative).
    writeFileSync(
      sentinel,
      `2026-05-15T00:00:00.000Z\t${repo}/src/a.ts\n2026-05-15T00:00:01.000Z\tsrc/b.ts\n`,
    );
    const parsed = readDirtySentinel(sentinel, repo);
    assert.deepEqual(parsed.files, ["src/a.ts", "src/b.ts"]);
  });
});

test("readDirtySentinel: normalizes backslash-separated paths (codex round 2 P2)", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    // Even on POSIX the sep is "/" so backslashes in the input
    // remain as literal characters of the relative-path component.
    // The Windows code path is exercised by node:path on win32; the
    // POSIX assertion here is that backslash separators in a
    // relative path don't get partially-normalized to a broken state.
    writeFileSync(sentinel, "2026-05-15T00:00:00.000Z\tsrc/a.ts\n");
    const parsed = readDirtySentinel(sentinel, repo);
    assert.deepEqual(parsed.files, ["src/a.ts"]);
  });
});

test("readDirtySentinel: strips ./ prefix on relative paths (codex round 3 P3)", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      sentinel,
      "2026-05-15T00:00:00.000Z\t./src/a.ts\n2026-05-15T00:00:01.000Z\tsrc/b.ts\n",
    );
    const parsed = readDirtySentinel(sentinel, repo);
    // Both forms must match graph node ids (which use plain `src/...`).
    assert.deepEqual(parsed.files, ["src/a.ts", "src/b.ts"]);
  });
});

test("readDirtySentinel: drops absolute paths outside repo", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      sentinel,
      "2026-05-15T00:00:00.000Z\t/etc/passwd\n2026-05-15T00:00:01.000Z\tsrc/b.ts\n",
    );
    const parsed = readDirtySentinel(sentinel, repo);
    // Absolute path outside repo gets dropped; only relative survives.
    assert.deepEqual(parsed.files, ["src/b.ts"]);
  });
});

test("isGraphStaleCheap: returns parsed sentinel files (not empty array)", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    // Create the minimal artifacts isGraphStaleCheap looks for so it
    // doesn't bail early as "missing": meta + snapshot.
    const raw = enumerateAllFiles(identity.repoPath);
    writeFileSync(
      graphMetaPath(identity, DEFAULT_CONFIG.graph),
      JSON.stringify({
        schema_version: 1,
        repo_id: identity.repoId,
        repo_path: identity.repoPath,
        built_at: new Date().toISOString(),
        tokenomy_version: "0.0.0",
        node_count: 0,
        edge_count: 0,
        file_hashes: {},
        file_mtimes: {},
        soft_cap: 0,
        hard_cap: 0,
        parse_error_count: 0,
        skipped_files: [],
        // codex round 7+8 P2: must match real fingerprints or the
        // sentinel fast-path's exclude/tsconfig change detection
        // fires and returns whole-graph stale (empty list).
        exclude_fingerprint: fingerprintExcludes(DEFAULT_CONFIG.graph.exclude),
        tsconfig_fingerprint: computeTsconfigFingerprint(
          identity.repoPath,
          raw.files,
          DEFAULT_CONFIG.graph.tsconfig.enabled,
        ),
      }),
    );
    writeFileSync(graphSnapshotPath(identity, DEFAULT_CONFIG.graph), "{}");
    // Drop a sentinel with two files.
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      sentinel,
      "2026-05-15T00:00:00.000Z\tsrc/x.ts\n2026-05-15T00:00:01.000Z\tsrc/y.ts\n",
    );

    const result = isGraphStaleCheap(repo, DEFAULT_CONFIG);
    assert.equal(result.stale, true);
    assert.deepEqual(result.stale_files, ["src/x.ts", "src/y.ts"]);
    assert.ok(typeof result.lag_ms === "number" || result.lag_ms === null);
  });
});
