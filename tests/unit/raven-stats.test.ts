import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRavenStats } from "../../src/raven/stats.js";
import { registerProject } from "../../src/util/projects-registry.js";

// 0.1.8+: collectRavenStats no longer walks `~/.tokenomy/raven/<repoId>/`.
// Single-repo callers pass `identity`; cross-repo callers rely on the
// project registry. Tests now use `withHome` to isolate registry writes
// and seed projects explicitly.

const withHome = <T>(fn: (home: string) => T): T => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-raven-stats-home-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
};

const seedRepoStorage = (repoPath: string): void => {
  for (const sub of ["packets", "reviews", "comparisons", "decisions"]) {
    mkdirSync(join(repoPath, ".tokenomy-raven", sub), { recursive: true });
  }
};

test("collectRavenStats: no projects registered → zeros + null last_activity", () => {
  withHome(() => {
    const stats = collectRavenStats(true);
    assert.equal(stats.enabled, true);
    assert.equal(stats.packets, 0);
    assert.equal(stats.reviews, 0);
    assert.equal(stats.comparisons, 0);
    assert.equal(stats.decisions, 0);
    assert.equal(stats.repos, 0);
    assert.equal(stats.last_activity, null);
  });
});

test("collectRavenStats: scoped to identity returns just that repo's counts", () => {
  withHome(() => {
    const repo = mkdtempSync(join(tmpdir(), "tokenomy-raven-stats-repo-"));
    try {
      seedRepoStorage(repo);
      writeFileSync(join(repo, ".tokenomy-raven", "packets", "p1.json"), "{}");
      writeFileSync(join(repo, ".tokenomy-raven", "packets", "p2.json"), "{}");
      writeFileSync(join(repo, ".tokenomy-raven", "reviews", "r1.json"), "{}");
      const stats = collectRavenStats(true, {
        identity: { repoId: "x", repoPath: repo },
      });
      assert.equal(stats.repos, 1);
      assert.equal(stats.packets, 2);
      assert.equal(stats.reviews, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("collectRavenStats: cross-repo walks registered projects only", () => {
  withHome(() => {
    const repoA = mkdtempSync(join(tmpdir(), "tokenomy-raven-stats-A-"));
    const repoB = mkdtempSync(join(tmpdir(), "tokenomy-raven-stats-B-"));
    try {
      seedRepoStorage(repoA);
      seedRepoStorage(repoB);
      writeFileSync(join(repoA, ".tokenomy-raven", "packets", "p1.json"), "{}");
      writeFileSync(join(repoB, ".tokenomy-raven", "decisions", "d1.json"), "{}");
      registerProject({ repoRoot: repoA, repoId: "A", raven_enabled: true });
      registerProject({ repoRoot: repoB, repoId: "B", raven_enabled: true });
      const stats = collectRavenStats(true);
      assert.equal(stats.repos, 2);
      assert.equal(stats.packets, 1);
      assert.equal(stats.decisions, 1);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});

test("collectRavenStats: identity for repo without a .tokenomy-raven dir is safe", () => {
  withHome(() => {
    const stats = collectRavenStats(false, {
      identity: { repoId: "x", repoPath: "/tmp/does-not-exist-xyz" },
    });
    assert.equal(stats.repos, 0);
    assert.equal(stats.packets, 0);
    assert.equal(stats.last_activity, null);
  });
});

test("collectRavenStats: include_legacy:false hides home-layout repos", () => {
  withHome((home) => {
    // Seed a legacy `~/.tokenomy/raven/<repoId>/packets/p.json`.
    const legacyRepoDir = join(home, ".tokenomy", "raven", "legacyA");
    mkdirSync(join(legacyRepoDir, "packets"), { recursive: true });
    writeFileSync(join(legacyRepoDir, "packets", "p.json"), "{}");
    const allOff = collectRavenStats(true, { include_legacy: false });
    assert.equal(allOff.repos, 0);
    const allOn = collectRavenStats(true);
    assert.equal(allOn.repos, 1);
    assert.equal(allOn.packets, 1);
  });
});
