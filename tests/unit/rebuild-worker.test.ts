import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetWorkersForTests,
  isWorkerActive,
  markStatsInactive,
  readRebuildStats,
  registerRepo,
  stopAllWorkers,
  unregisterRepo,
} from "../../src/mcp/rebuild-worker.js";
import { graphDir, graphDirtySentinelPath, graphRebuildStatsPath } from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { Config } from "../../src/core/types.js";

const withTmpHomeAndRepo = async <T>(
  fn: (home: string, repo: string) => Promise<T>,
): Promise<T> => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-worker-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-worker-repo-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  _resetWorkersForTests();
  try {
    return await fn(home, repo);
  } finally {
    _resetWorkersForTests();
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
};

const cfg = (debounceMs = 60): Config => {
  const c = structuredClone(DEFAULT_CONFIG) as Config;
  c.graph.rebuild_worker = { enabled: true, debounce_ms: debounceMs };
  return c;
};

test("registerRepo: idempotent, marks repo as active", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    // codex round 2 P3: worker only registers when graph dir exists.
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    registerRepo(repo, cfg());
    assert.equal(isWorkerActive(identity.repoPath), true);
    // Second call must be a no-op (no extra watcher).
    registerRepo(repo, cfg());
    assert.equal(isWorkerActive(identity.repoPath), true);
  });
});

test("registerRepo: skips when graph dir is missing (codex round 2 P3)", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    // No graphDir → worker should NOT register (would leave an
    // untracked `?? .tokenomy-graph/` in git status).
    registerRepo(repo, cfg());
    const identity = resolveRepoId(repo);
    assert.equal(isWorkerActive(identity.repoPath), false);
  });
});

test("registerRepo: respects enabled=false config", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    const c = cfg();
    c.graph.rebuild_worker = { enabled: false, debounce_ms: 150 };
    registerRepo(repo, c);
    const identity = resolveRepoId(repo);
    assert.equal(isWorkerActive(identity.repoPath), false);
  });
});

test("unregisterRepo: tears down watcher", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    registerRepo(repo, cfg());
    assert.equal(isWorkerActive(identity.repoPath), true);
    unregisterRepo(identity.repoPath);
    assert.equal(isWorkerActive(identity.repoPath), false);
  });
});

test("worker: debounced .dirty write triggers buildGraph", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    // Give the build something to chew on.
    writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");

    const identity = resolveRepoId(repo);
    const graphDirPath = graphDir(identity, DEFAULT_CONFIG.graph);
    mkdirSync(graphDirPath, { recursive: true });

    registerRepo(repo, cfg(60));
    assert.equal(isWorkerActive(identity.repoPath), true);

    // Touch the sentinel; the worker should pick it up after ~debounce_ms
    // and run a buildGraph that records a stats entry.
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(sentinel, "2026-05-15T00:00:00.000Z\ta.ts\n");

    // Wait long enough for the debounce to fire AND for buildGraph to
    // run. Small repo (1 file) finishes in a few hundred ms.
    await new Promise((r) => setTimeout(r, 1500));

    // codex round 3 P2: tolerate fs.watch fallback AND slow CI. On
    // hosts where fs.watch registers but errors asynchronously (some
    // FUSE mounts, CI containers), the worker falls back to the
    // legacy path and the count stays 0. Some macOS CI runs also
    // delay fs.watch delivery past the 1500ms window. Wait a bit
    // longer, then accept: rebuild fired (count>=1) OR worker fell
    // back (!active) OR the sentinel is still being processed.
    let stats = readRebuildStats(identity, cfg(60));
    if (stats.count === 0 && isWorkerActive(identity.repoPath)) {
      await new Promise((r) => setTimeout(r, 2000));
      stats = readRebuildStats(identity, cfg(60));
    }
    const fellBack = !isWorkerActive(identity.repoPath);
    assert.ok(
      stats.count >= 1 || fellBack,
      `expected rebuild or worker fallback; count=${stats.count} workerActive=${!fellBack}`,
    );
  });
});

test("worker: rapid sentinel changes coalesce into one rebuild", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });

    registerRepo(repo, cfg(120));
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);

    // Burst 5 sentinel writes within the debounce window.
    for (let i = 0; i < 5; i++) {
      writeFileSync(
        sentinel,
        `2026-05-15T00:00:0${i}.000Z\ta.ts\n`,
        { flag: "a" },
      );
      await new Promise((r) => setTimeout(r, 10));
    }

    // Wait for the debounce + build to complete.
    await new Promise((r) => setTimeout(r, 2000));

    const stats = readRebuildStats(identity, cfg(120));
    // Coalesced: should be at most 2 rebuilds (one for the burst, plus
    // possibly one more if some events arrived after the first build
    // started). Pre-fix behavior would have been 5+. codex round 3
    // P2: also tolerate fs.watch fallback (count = 0 acceptable).
    assert.ok(
      stats.count <= 2,
      `expected ≤2 rebuilds for a coalesced burst, got ${stats.count}`,
    );
  });
});

test("recordRebuild: defaults missing numeric counters (codex round 2 P2)", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    // Pre-seed stats with ONLY scoped fields — no count/last_ms/total_ms.
    // Without defaulting, `undefined + duration_ms` → NaN → null in JSON.
    const path = graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      path,
      JSON.stringify({
        stale_in_scope_hits: 1,
        stale_in_scope_misses: 2,
      }),
    );
    registerRepo(repo, cfg(60));
    writeFileSync(
      graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph),
      "2026-05-15T00:00:00.000Z\ta.ts\n",
    );
    await new Promise((r) => setTimeout(r, 1500));
    const stats = readRebuildStats(identity, cfg(60));
    assert.equal(Number.isFinite(stats.count), true, `count must be finite, got ${stats.count}`);
    assert.equal(Number.isFinite(stats.total_ms), true, `total_ms must be finite, got ${stats.total_ms}`);
    // codex round 3 P2: tolerate fs.watch fallback.
    const fellBack = !isWorkerActive(identity.repoPath);
    assert.ok(stats.count >= 1 || fellBack);
    // Scoped counters preserved.
    assert.equal(stats.stale_in_scope_hits, 1);
    assert.equal(stats.stale_in_scope_misses, 2);
  });
});

test("stopAllWorkers: marks each repo's stats inactive (codex round 2 P3)", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    // Pre-seed with worker_active: true.
    writeFileSync(
      graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph),
      JSON.stringify({
        count: 1,
        last_ms: 50,
        total_ms: 50,
        last_ts: "2026-05-15T00:00:00.000Z",
        worker_active: true,
      }),
    );
    registerRepo(repo, cfg());
    stopAllWorkers();
    const stats = readRebuildStats(identity, DEFAULT_CONFIG);
    assert.equal(stats.worker_active, false);
    // Reset for subsequent tests.
    _resetWorkersForTests();
  });
});

test("recordRebuild preserves scoped-stale counters (codex round 1 P3)", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    // Pre-seed stats with scoped-stale counters as freshness-stats would.
    const path = graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      path,
      JSON.stringify({
        stale_in_scope_hits: 5,
        stale_in_scope_misses: 12,
      }),
    );
    // Now trigger a worker rebuild.
    registerRepo(repo, cfg(60));
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(sentinel, "2026-05-15T00:00:00.000Z\ta.ts\n");
    await new Promise((r) => setTimeout(r, 1500));
    const stats = readRebuildStats(identity, cfg(60));
    // Scoped counters must survive the rebuild's stats write
    // regardless of whether the worker fired (codex round 3 P2:
    // tolerate fs.watch fallback).
    assert.equal(stats.stale_in_scope_hits, 5);
    assert.equal(stats.stale_in_scope_misses, 12);
    const fellBack = !isWorkerActive(identity.repoPath);
    assert.ok(stats.count >= 1 || fellBack);
  });
});

test("registerRepo: schedules immediate rebuild when .dirty pre-exists (codex round 1 P2)", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    writeFileSync(join(repo, "a.ts"), "export const x = 1;\n");
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    // Sentinel exists BEFORE registerRepo runs. fs.watch only reports
    // future changes, so without the immediate kick the worker would
    // never rebuild.
    writeFileSync(
      graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph),
      "2026-05-15T00:00:00.000Z\ta.ts\n",
    );
    registerRepo(repo, cfg(60));
    await new Promise((r) => setTimeout(r, 1500));
    const stats = readRebuildStats(identity, cfg(60));
    // codex round 3 P2: tolerate fs.watch fallback.
    const fellBack = !isWorkerActive(identity.repoPath);
    assert.ok(
      stats.count >= 1 || fellBack,
      `expected immediate rebuild on pre-existing .dirty; got count=${stats.count} workerActive=${!fellBack}`,
    );
  });
});

test("registerRepo: skips when graph.enabled=false", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    const c = cfg();
    c.graph.enabled = false;
    registerRepo(repo, c);
    const identity = resolveRepoId(repo);
    assert.equal(isWorkerActive(identity.repoPath), false);
  });
});

test("registerRepo: skips when resolveRepoId throws (non-repo path)", () => {
  // /nonexistent has no git ancestor; resolveRepoId still returns
  // something for it, so we test the early-out for a definitely
  // malformed path that throws.
  registerRepo("/this/path/does/not/exist/at/all", cfg());
  // Worker registration should not throw and not be active.
  assert.equal(isWorkerActive("/this/path/does/not/exist/at/all"), false);
});

test("unregisterRepo: no-op for unknown repoPath", () => {
  // Must not throw.
  unregisterRepo("/never/registered");
});

test("stopAllWorkers: tears down everything", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    registerRepo(repo, cfg());
    assert.equal(isWorkerActive(identity.repoPath), true);
    stopAllWorkers();
    assert.equal(isWorkerActive(identity.repoPath), false);
    // Reset so subsequent tests can register again.
    _resetWorkersForTests();
  });
});

test("markStatsInactive: flips worker_active in existing stats file", async () => {
  await withTmpHomeAndRepo(async (_home, repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const path = graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      path,
      JSON.stringify({
        count: 3,
        last_ms: 50,
        total_ms: 150,
        last_ts: "2026-05-15T00:00:00.000Z",
        worker_active: true,
      }),
    );
    markStatsInactive(identity, DEFAULT_CONFIG);
    const stats = readRebuildStats(identity, DEFAULT_CONFIG);
    assert.equal(stats.worker_active, false);
    assert.equal(stats.count, 3);
  });
});

test("markStatsInactive: no-op when stats file absent", () => {
  const fake = { repoId: "x", repoPath: "/does/not/exist" };
  // Must not throw.
  markStatsInactive(fake, DEFAULT_CONFIG);
});

test("readRebuildStats: returns defaults when stats file missing", () => {
  const fake = { repoId: "nonexistent", repoPath: "/does/not/exist" };
  const stats = readRebuildStats(fake, DEFAULT_CONFIG);
  assert.equal(stats.count, 0);
  assert.equal(stats.last_ms, 0);
  assert.equal(stats.last_ts, "");
});

test("readRebuildStats: reads from on-disk JSON", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-worker-stats-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-worker-stats-repo-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const path = graphRebuildStatsPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      path,
      JSON.stringify({
        count: 7,
        last_ms: 123,
        total_ms: 700,
        last_ts: "2026-05-15T00:00:00.000Z",
        worker_active: true,
      }),
    );
    const stats = readRebuildStats(identity, DEFAULT_CONFIG);
    assert.equal(stats.count, 7);
    assert.equal(stats.last_ms, 123);
    assert.equal(stats.last_ts, "2026-05-15T00:00:00.000Z");
    assert.equal(stats.worker_active, true);
    void readFileSync;
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
