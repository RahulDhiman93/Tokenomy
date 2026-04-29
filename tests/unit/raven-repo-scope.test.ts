import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRavenStats } from "../../src/raven/stats.js";

const setup = (): string => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-scope-"));
  // Two repo subdirs, each with two packets.
  for (const repoId of ["repoA", "repoB"]) {
    for (const sub of ["packets", "reviews", "comparisons", "decisions"]) {
      mkdirSync(join(root, repoId, sub), { recursive: true });
    }
  }
  writeFileSync(join(root, "repoA", "packets", "p1.json"), "{}");
  writeFileSync(join(root, "repoA", "packets", "p2.json"), "{}");
  writeFileSync(join(root, "repoA", "reviews", "r1.json"), "{}");
  writeFileSync(join(root, "repoB", "packets", "p1.json"), "{}");
  writeFileSync(join(root, "repoB", "decisions", "d1.json"), "{}");
  return root;
};

test("collectRavenStats: with repoId scopes counters to that one repo", () => {
  const root = setup();
  try {
    const a = collectRavenStats(root, true, { repoId: "repoA" });
    assert.equal(a.repos, 1);
    assert.equal(a.packets, 2);
    assert.equal(a.reviews, 1);
    assert.equal(a.decisions, 0);
    const b = collectRavenStats(root, true, { repoId: "repoB" });
    assert.equal(b.repos, 1);
    assert.equal(b.packets, 1);
    assert.equal(b.decisions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectRavenStats: without repoId aggregates across all repos (--all-repos)", () => {
  const root = setup();
  try {
    const all = collectRavenStats(root, true);
    assert.equal(all.repos, 2);
    assert.equal(all.packets, 3);
    assert.equal(all.reviews, 1);
    assert.equal(all.decisions, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectRavenStats: nonexistent repoId returns zero counts, repos: 0", () => {
  const root = setup();
  try {
    const r = collectRavenStats(root, true, { repoId: "doesNotExist" });
    assert.equal(r.repos, 0);
    assert.equal(r.packets, 0);
    assert.equal(r.last_activity, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
