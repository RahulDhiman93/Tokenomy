import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getPrReadiness } from "../../src/raven/pr-check.js";
import type { RavenPacket, RavenReview } from "../../src/raven/schema.js";
import type { RavenStore } from "../../src/raven/store.js";

const git = (cwd: string, args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const withRepo = <T>(fn: (repo: string, head: string) => T): T => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-raven-pr-repo-"));
  try {
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "raven@example.test"]);
    git(repo, ["config", "user.name", "Raven Test"]);
    writeFileSync(join(repo, "src.ts"), "export const x = 1;\n");
    git(repo, ["add", "src.ts"]);
    git(repo, ["commit", "-m", "init"]);
    return fn(repo, git(repo, ["rev-parse", "HEAD"]));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

const packet = (repo: string, head: string, dirty = false): RavenPacket => ({
  schema_version: 1,
  packet_id: "pkt-1",
  created_at: "2026-04-22T00:00:00.000Z",
  repo: { root: repo, repo_id: "repo", branch: "main", head_sha: head, dirty },
  source: { agent: "claude-code" },
  target: { agent: "codex", intent: "pr-check" },
  git: {
    staged_files: [],
    unstaged_files: [],
    untracked_files: [],
    changed_files: ["src.ts"],
    stats: [],
    diff_summary: [],
    dropped_files: 0,
    diff_truncated: false,
  },
  graph: {
    review_context: { ok: true, stale: false },
    impact_radius: { ok: true, data: { suggested_tests: ["npm test -- src"] } },
  },
  risks: [],
  review_focus: [],
  open_questions: [],
});

const review = (
  reviewId: string,
  finding: RavenReview["findings"][number] | null,
  verdict: RavenReview["verdict"] = "pass",
): RavenReview => ({
  schema_version: 1,
  review_id: reviewId,
  packet_id: "pkt-1",
  agent: reviewId === "claude" ? "claude-code" : "codex",
  created_at: "2026-04-22T00:00:00.000Z",
  verdict,
  findings: finding ? [finding] : [],
  questions: [],
  suggested_tests: [],
});

const store = (dir: string): RavenStore => ({
  dir,
  packetsDir: join(dir, "packets"),
  reviewsDir: join(dir, "reviews"),
  comparisonsDir: join(dir, "comparisons"),
  decisionsDir: join(dir, "decisions"),
});

test("raven pr-check: blocks when no reviews are recorded", () => {
  withRepo((repo, head) => {
    const dir = mkdtempSync(join(tmpdir(), "tokenomy-raven-pr-store-"));
    try {
      const out = getPrReadiness(packet(repo, head), repo, store(dir), []);
      assert.equal(out.ok, true);
      if (!out.ok) return;
      assert.equal(out.data.ready, "no");
      assert.deepEqual(out.data.blocking, ["No reviews recorded for packet."]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("raven pr-check: stale head is a blocking failure", () => {
  withRepo((repo) => {
    const dir = mkdtempSync(join(tmpdir(), "tokenomy-raven-pr-store-"));
    try {
      const out = getPrReadiness(packet(repo, "deadbeef"), repo, store(dir), [review("claude", null)]);
      assert.equal(out.ok, true);
      if (!out.ok) return;
      assert.equal(out.data.ready, "no");
      assert.match(out.data.blocking.join("\n"), /Current HEAD differs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("raven pr-check: unresolved critical finding blocks merge", () => {
  withRepo((repo, head) => {
    const dir = mkdtempSync(join(tmpdir(), "tokenomy-raven-pr-store-"));
    try {
      const out = getPrReadiness(packet(repo, head), repo, store(dir), [
        review("claude", { severity: "critical", title: "Deletes data", detail: "A critical issue." }),
      ]);
      assert.equal(out.ok, true);
      if (!out.ok) return;
      assert.equal(out.data.ready, "no");
      assert.match(out.data.blocking.join("\n"), /Critical finding: Deletes data/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("raven pr-check: high-severity disagreement makes readiness risky", () => {
  withRepo((repo, head) => {
    const dir = mkdtempSync(join(tmpdir(), "tokenomy-raven-pr-store-"));
    try {
      const out = getPrReadiness(packet(repo, head), repo, store(dir), [
        review("claude", { severity: "high", file: "src.ts", line: 1, title: "Bad auth", detail: "Claude finding." }),
        review("codex", { severity: "high", file: "src.ts", line: 2, title: "Bad cache", detail: "Codex finding." }),
      ]);
      assert.equal(out.ok, true);
      if (!out.ok) return;
      assert.equal(out.data.ready, "risky");
      assert.match(out.data.warnings.join("\n"), /High-severity disagreement/);
      assert.deepEqual(out.data.suggested_tests, ["npm test -- src"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("raven pr-check: clean reviewed packet is ready", () => {
  withRepo((repo, head) => {
    const dir = mkdtempSync(join(tmpdir(), "tokenomy-raven-pr-store-"));
    try {
      const out = getPrReadiness(packet(repo, head), repo, store(dir), [review("claude", null)]);
      assert.equal(out.ok, true);
      if (!out.ok) return;
      assert.equal(out.data.ready, "yes");
      assert.deepEqual(out.data.blocking, []);
      assert.deepEqual(out.data.warnings, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
