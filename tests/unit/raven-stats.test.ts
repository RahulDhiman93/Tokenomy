import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectRavenStats } from "../../src/raven/stats.js";

const makeRavenRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-"));
  for (const repoId of ["repoA", "repoB"]) {
    const base = join(root, repoId);
    for (const sub of ["packets", "reviews", "comparisons", "decisions"]) {
      mkdirSync(join(base, sub), { recursive: true });
    }
  }
  return root;
};

test("collectRavenStats: empty root returns zeros and null last_activity", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-empty-"));
  try {
    const stats = collectRavenStats(root, true);
    assert.equal(stats.enabled, true);
    assert.equal(stats.packets, 0);
    assert.equal(stats.reviews, 0);
    assert.equal(stats.comparisons, 0);
    assert.equal(stats.decisions, 0);
    assert.equal(stats.repos, 0);
    assert.equal(stats.last_activity, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectRavenStats: nonexistent root is safe", () => {
  const stats = collectRavenStats("/nonexistent-raven-root-xxxxx", false);
  assert.equal(stats.packets, 0);
  assert.equal(stats.repos, 0);
  assert.equal(stats.last_activity, null);
});

test("collectRavenStats: counts JSON files across repos and populates last_activity", () => {
  const root = makeRavenRoot();
  try {
    writeFileSync(join(root, "repoA/packets/p1.json"), "{}");
    writeFileSync(join(root, "repoA/packets/p2.json"), "{}");
    writeFileSync(join(root, "repoA/packets/skip.md"), "# not json");
    writeFileSync(join(root, "repoA/reviews/r1.json"), "{}");
    writeFileSync(join(root, "repoB/packets/p1.json"), "{}");
    writeFileSync(join(root, "repoB/comparisons/c1.json"), "{}");
    writeFileSync(join(root, "repoB/decisions/d1.json"), "{}");

    const stats = collectRavenStats(root, false);
    assert.equal(stats.enabled, false);
    assert.equal(stats.repos, 2);
    assert.equal(stats.packets, 3);
    assert.equal(stats.reviews, 1);
    assert.equal(stats.comparisons, 1);
    assert.equal(stats.decisions, 1);
    assert.ok(stats.last_activity !== null, "expected last_activity to be set");
    assert.ok(
      Number.isFinite(Date.parse(stats.last_activity ?? "")),
      "expected last_activity to parse as ISO timestamp",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectRavenStats: non-directory entries under root are skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-mixed-"));
  try {
    writeFileSync(join(root, "stray-file"), "oops");
    mkdirSync(join(root, "repoX/packets"), { recursive: true });
    writeFileSync(join(root, "repoX/packets/p.json"), "{}");
    const stats = collectRavenStats(root, true);
    assert.equal(stats.repos, 1);
    assert.equal(stats.packets, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
