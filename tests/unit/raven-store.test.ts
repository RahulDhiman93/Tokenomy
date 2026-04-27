import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanStore,
  ensureRavenStore,
  listReviews,
  readLatestPacket,
  readPacket,
  readReview,
  saveComparison,
  saveDecision,
  savePacket,
  saveReview,
  type RavenStore,
} from "../../src/raven/store.js";
import type {
  RavenComparison,
  RavenDecision,
  RavenPacket,
  RavenReview,
} from "../../src/raven/schema.js";

const makeStore = (root: string): RavenStore => ({
  dir: root,
  packetsDir: join(root, "packets"),
  reviewsDir: join(root, "reviews"),
  comparisonsDir: join(root, "comparisons"),
  decisionsDir: join(root, "decisions"),
});

const fakePacket = (id: string): RavenPacket => ({
  schema_version: 1,
  packet_id: id,
  created_at: "2026-04-26T00:00:00Z",
  repo: { root: "/tmp", repo_id: "rid", branch: "main", head_sha: "sha", dirty: false },
  source: {},
  git: {
    staged_files: [],
    unstaged_files: [],
    untracked_files: [],
    changed_files: [],
    stats: [],
    diff_summary: [],
    dropped_files: 0,
    diff_truncated: false,
  },
  risks: [],
  review_focus: [],
  open_questions: [],
});

const fakeReview = (id: string, packetId: string): RavenReview => ({
  schema_version: 1,
  review_id: id,
  packet_id: packetId,
  agent: "codex",
  created_at: "2026-04-26T00:00:01Z",
  verdict: "pass",
  findings: [],
  questions: [],
  suggested_tests: [],
});

test("ravenStore: savePacket → readPacket round-trip + latest pointer", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-store-"));
  try {
    const store = makeStore(root);
    const packet = fakePacket("p1");
    savePacket(store, packet, "# md");
    assert.deepEqual(readPacket(store, "p1"), packet);
    assert.deepEqual(readLatestPacket(store), packet);
    // The markdown file is also written next to the JSON.
    const md = readFileSync(join(store.packetsDir, "p1.md"), "utf8");
    assert.equal(md, "# md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ravenStore: readPacket() with no id falls back to latest", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-store-"));
  try {
    const store = makeStore(root);
    const a = fakePacket("a");
    const b = fakePacket("b");
    savePacket(store, a, "# a");
    savePacket(store, b, "# b");
    // Latest pointer reflects the last savePacket.
    assert.deepEqual(readPacket(store), b);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ravenStore: readPacket on missing id returns null", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-store-"));
  try {
    const store = makeStore(root);
    ensureRavenStore(store);
    assert.equal(readPacket(store, "missing"), null);
    assert.equal(readLatestPacket(store), null);
    assert.equal(readReview(store, "missing"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ravenStore: saveReview / listReviews filters by packet id, sorts by created_at", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-store-"));
  try {
    const store = makeStore(root);
    const pid = "pkt";
    saveReview(store, { ...fakeReview("r2", pid), created_at: "2026-04-26T00:00:02Z" }, "# r2");
    saveReview(store, { ...fakeReview("r1", pid), created_at: "2026-04-26T00:00:01Z" }, "# r1");
    saveReview(
      store,
      { ...fakeReview("r-other", "different-packet"), created_at: "2026-04-26T00:00:03Z" },
      "# other",
    );
    // Filtered + sorted ascending by created_at.
    const filtered = listReviews(store, pid);
    assert.deepEqual(filtered.map((r) => r.review_id), ["r1", "r2"]);
    // No filter — all three.
    assert.equal(listReviews(store).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ravenStore: listReviews handles missing dir gracefully", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-store-"));
  try {
    const store = makeStore(root);
    // Don't ensure() — reviewsDir doesn't exist.
    assert.deepEqual(listReviews(store), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ravenStore: saveComparison + saveDecision write JSON + markdown", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-store-"));
  try {
    const store = makeStore(root);
    const cmp: RavenComparison = {
      schema_version: 1,
      comparison_id: "cid",
      packet_id: "pid",
      reviews: ["r1"],
      agreements: [],
      disagreements: [],
      unique_findings: [],
      likely_false_positives: [],
      recommended_action: "merge",
    };
    saveComparison(store, cmp, "# cmp");
    assert.match(
      readFileSync(join(store.comparisonsDir, "cid.md"), "utf8"),
      /# cmp/,
    );
    const dec: RavenDecision = {
      schema_version: 1,
      decision_id: "did",
      packet_id: "pid",
      decision: "merge",
      rationale: "tests green",
      decided_by: "human",
      review_ids: ["r1"],
      created_at: "2026-04-26T00:00:00Z",
    };
    saveDecision(store, dec, "# dec");
    assert.match(
      readFileSync(join(store.decisionsDir, "did.md"), "utf8"),
      /# dec/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ravenStore: cleanStore returns empty when dir missing", () => {
  const result = cleanStore(makeStore("/nonexistent-raven-clean"), {
    keep: 5,
    olderThanDays: 7,
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.data.removed, []);
});

test("ravenStore: cleanStore removes excess + old files; respects dryRun", () => {
  const root = mkdtempSync(join(tmpdir(), "tokenomy-raven-clean-"));
  try {
    const store = makeStore(root);
    // Write 4 packets; we'll keep 2.
    for (const id of ["p1", "p2", "p3", "p4"]) {
      savePacket(store, fakePacket(id), `# ${id}`);
    }
    // Bump older mtimes so the BEST sort places p1, p2 oldest.
    const oldMs = (Date.now() - 100 * 86_400_000) / 1000;
    utimesSync(join(store.packetsDir, "p1.json"), oldMs, oldMs);
    utimesSync(join(store.packetsDir, "p2.json"), oldMs, oldMs);
    const dry = cleanStore(store, { keep: 2, olderThanDays: 30, dryRun: true });
    assert.equal(dry.ok, true);
    if (dry.ok) {
      assert.ok(dry.data.removed.length > 0);
      // Dry run: files should still exist.
      assert.ok(statSync(join(store.packetsDir, "p1.json")));
    }
    const real = cleanStore(store, { keep: 2, olderThanDays: 30 });
    assert.equal(real.ok, true);
    if (real.ok) {
      assert.ok(real.data.removed.length > 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
