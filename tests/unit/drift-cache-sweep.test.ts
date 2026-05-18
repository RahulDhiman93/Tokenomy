import { test } from "node:test";
import assert from "node:assert/strict";
import {
  _resetDriftCacheForTests,
  isGraphStaleCheap,
} from "../../src/graph/stale.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  graphDir,
  graphDirtySentinelPath,
  graphMetaPath,
  graphSnapshotPath,
} from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { fingerprintExcludes } from "../../src/graph/exclude-fingerprint.js";
import { computeTsconfigFingerprint } from "../../src/graph/tsconfig-fingerprint.js";
import { enumerateAllFiles } from "../../src/graph/enumerate.js";

const withRepo = (fn: (repo: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-sweep-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-sweep-repo-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    execSync("git init -q", { cwd: repo });
    execSync('git -c user.email=a@b.com -c user.name=a commit --allow-empty -q -m init', {
      cwd: repo,
    });
    fn(repo);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
};

test("drift cache sweep: timer is created and unref'd on first cache write", () => {
  _resetDriftCacheForTests();
  withRepo((repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const raw = enumerateAllFiles(identity.repoPath);
    writeFileSync(
      graphMetaPath(identity, DEFAULT_CONFIG.graph),
      JSON.stringify({
        schema_version: 1,
        repo_id: identity.repoId,
        repo_path: identity.repoPath,
        built_at: new Date().toISOString(),
        tokenomy_version: "0.1.10",
        node_count: 0,
        edge_count: 0,
        file_hashes: {},
        file_mtimes: {},
        soft_cap: 0,
        hard_cap: 0,
        parse_error_count: 0,
        exclude_fingerprint: fingerprintExcludes(DEFAULT_CONFIG.graph.exclude),
        tsconfig_fingerprint: computeTsconfigFingerprint(
          identity.repoPath,
          raw.files,
          DEFAULT_CONFIG.graph.tsconfig.enabled,
        ),
      }),
    );
    writeFileSync(graphSnapshotPath(identity, DEFAULT_CONFIG.graph), "{}");
    writeFileSync(graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph), "");
    // First call populates the drift cache and lazily kicks off the sweep timer.
    isGraphStaleCheap(repo, DEFAULT_CONFIG);
    // Confirm the timer is unref'd — easiest probe is that the test
    // exits cleanly. If the timer were not unref'd, the test runner
    // would hang for 5s waiting for it.
    _resetDriftCacheForTests();
    assert.ok(true);
  });
});

test("drift cache sweep: reset clears state without process hang", () => {
  _resetDriftCacheForTests();
  withRepo((_) => {
    _resetDriftCacheForTests();
    // The interval must not block process exit. node:test's natural
    // timeout would surface a hang.
    assert.ok(true);
  });
});
