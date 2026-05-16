import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectGraphFreshness,
  recordScopedStaleSample,
} from "../../src/graph/freshness-stats.js";
import {
  graphDir,
  graphDirtySentinelPath,
  graphRebuildStatsPath,
} from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";

const withTmpHomeAndRepo = (fn: (home: string, repo: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-freshness-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-freshness-repo-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    fn(home, repo);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
};

test("collectGraphFreshness: returns zero defaults when no stats and no sentinel", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    const stats = collectGraphFreshness(identity, DEFAULT_CONFIG);
    assert.equal(stats.worker_active, false);
    assert.equal(stats.rebuild_count, 0);
    assert.equal(stats.last_rebuild_ms, 0);
    assert.equal(stats.avg_rebuild_ms, 0);
    assert.equal(stats.last_rebuild_ts, null);
    assert.equal(stats.dirty_files_pending, 0);
    assert.equal(stats.stale_in_scope_hits, 0);
    assert.equal(stats.stale_in_scope_misses, 0);
  });
});

test("collectGraphFreshness: hydrates from stats JSON + counts dirty files", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    writeFileSync(
      graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph),
      JSON.stringify({
        count: 4,
        last_ms: 80,
        total_ms: 400,
        last_ts: "2026-05-15T00:00:00.000Z",
        worker_active: true,
        stale_in_scope_hits: 2,
        stale_in_scope_misses: 7,
      }),
    );
    writeFileSync(
      graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph),
      "2026-05-15T00:00:00.000Z\tsrc/a.ts\n2026-05-15T00:00:01.000Z\tsrc/b.ts\n",
    );
    const stats = collectGraphFreshness(identity, DEFAULT_CONFIG);
    assert.equal(stats.worker_active, true);
    assert.equal(stats.rebuild_count, 4);
    assert.equal(stats.last_rebuild_ms, 80);
    assert.equal(stats.avg_rebuild_ms, 100);
    assert.equal(stats.last_rebuild_ts, "2026-05-15T00:00:00.000Z");
    assert.equal(stats.dirty_files_pending, 2);
    assert.equal(stats.stale_in_scope_hits, 2);
    assert.equal(stats.stale_in_scope_misses, 7);
  });
});

test("collectGraphFreshness: tolerates malformed stats JSON", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    writeFileSync(graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph), "{ not json");
    const stats = collectGraphFreshness(identity, DEFAULT_CONFIG);
    // safeParse returns null → treated as empty stored stats.
    assert.equal(stats.rebuild_count, 0);
  });
});

test("recordScopedStaleSample: increments hits + misses cumulatively", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    recordScopedStaleSample(identity, DEFAULT_CONFIG, true);
    recordScopedStaleSample(identity, DEFAULT_CONFIG, true);
    recordScopedStaleSample(identity, DEFAULT_CONFIG, false);
    const stats = collectGraphFreshness(identity, DEFAULT_CONFIG);
    assert.equal(stats.stale_in_scope_hits, 2);
    assert.equal(stats.stale_in_scope_misses, 1);
    const raw = readFileSync(
      graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    assert.equal(parsed.stale_in_scope_hits, 2);
    assert.equal(parsed.stale_in_scope_misses, 1);
  });
});

test("recordScopedStaleSample: best-effort on malformed prior stats", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    writeFileSync(graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph), "{ bad");
    // safeParse returns null; recordScopedStaleSample re-initializes.
    recordScopedStaleSample(identity, DEFAULT_CONFIG, true);
    const stats = collectGraphFreshness(identity, DEFAULT_CONFIG);
    assert.equal(stats.stale_in_scope_hits, 1);
  });
});
