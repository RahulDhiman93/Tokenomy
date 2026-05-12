import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRavenStats } from "../../src/raven/stats.js";
import { registerProject } from "../../src/util/projects-registry.js";

// 0.1.8+: collectRavenStats is identity-scoped (per-repo) or registry-driven
// (cross-repo). Pre-0.1.8 it took a root path + optional repoId string.

interface SetupResult {
  home: string;
  repoA: string;
  repoB: string;
  restore: () => void;
}

const setup = (): SetupResult => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-raven-scope-home-"));
  const repoA = mkdtempSync(join(tmpdir(), "tokenomy-raven-scope-A-"));
  const repoB = mkdtempSync(join(tmpdir(), "tokenomy-raven-scope-B-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  for (const repo of [repoA, repoB]) {
    for (const sub of ["packets", "reviews", "comparisons", "decisions"]) {
      mkdirSync(join(repo, ".tokenomy-raven", sub), { recursive: true });
    }
  }
  writeFileSync(join(repoA, ".tokenomy-raven", "packets", "p1.json"), "{}");
  writeFileSync(join(repoA, ".tokenomy-raven", "packets", "p2.json"), "{}");
  writeFileSync(join(repoA, ".tokenomy-raven", "reviews", "r1.json"), "{}");
  writeFileSync(join(repoB, ".tokenomy-raven", "packets", "p1.json"), "{}");
  writeFileSync(join(repoB, ".tokenomy-raven", "decisions", "d1.json"), "{}");
  registerProject({ repoRoot: repoA, repoId: "repoA", raven_enabled: true });
  registerProject({ repoRoot: repoB, repoId: "repoB", raven_enabled: true });
  return {
    home,
    repoA,
    repoB,
    restore: () => {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    },
  };
};

test("collectRavenStats: with identity scopes counters to that one repo", () => {
  const s = setup();
  try {
    const a = collectRavenStats(true, {
      identity: { repoId: "repoA", repoPath: s.repoA },
    });
    assert.equal(a.repos, 1);
    assert.equal(a.packets, 2);
    assert.equal(a.reviews, 1);
    assert.equal(a.decisions, 0);
    const b = collectRavenStats(true, {
      identity: { repoId: "repoB", repoPath: s.repoB },
    });
    assert.equal(b.repos, 1);
    assert.equal(b.packets, 1);
    assert.equal(b.decisions, 1);
  } finally {
    s.restore();
  }
});

test("collectRavenStats: without identity aggregates across the registered project list", () => {
  const s = setup();
  try {
    const all = collectRavenStats(true);
    assert.equal(all.repos, 2);
    assert.equal(all.packets, 3);
    assert.equal(all.reviews, 1);
    assert.equal(all.decisions, 1);
  } finally {
    s.restore();
  }
});

test("collectRavenStats: unknown identity returns zero counts", () => {
  const s = setup();
  try {
    const r = collectRavenStats(true, {
      identity: { repoId: "doesNotExist", repoPath: "/tmp/no-such-path-xyz" },
    });
    assert.equal(r.repos, 0);
    assert.equal(r.packets, 0);
    assert.equal(r.last_activity, null);
  } finally {
    s.restore();
  }
});
