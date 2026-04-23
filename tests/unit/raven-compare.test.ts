import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { compareReviews } from "../../src/raven/compare.js";
import type { RavenPacket, RavenReview } from "../../src/raven/schema.js";
import type { RavenStore } from "../../src/raven/store.js";

const git = (cwd: string, args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const withRepo = <T>(fn: (repo: string, head: string) => T): T => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-raven-compare-repo-"));
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

const packet = (repo: string, head: string): RavenPacket => ({
  schema_version: 1,
  packet_id: "pkt-1",
  created_at: "2026-04-22T00:00:00.000Z",
  repo: { root: repo, repo_id: "repo", branch: "main", head_sha: head, dirty: false },
  source: { agent: "claude-code" },
  target: { agent: "codex", intent: "review" },
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
  risks: [],
  review_focus: [],
  open_questions: [],
});

const review = (reviewId: string, line: number | undefined): RavenReview => ({
  schema_version: 1,
  review_id: reviewId,
  packet_id: "pkt-1",
  agent: reviewId === "r1" ? "claude-code" : "codex",
  created_at: "2026-04-22T00:00:00.000Z",
  verdict: "needs-work",
  findings: [
    {
      severity: "high",
      file: "src.ts",
      line,
      title: "Drops user auth",
      detail: "The same title should only match when file, line, and severity match.",
    },
  ],
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

test("raven compare: matching uses file, exact line, severity, and title", () => {
  withRepo((repo, head) => {
    const out = compareReviews(packet(repo, head), repo, store(mkdtempSync(join(tmpdir(), "tokenomy-raven-store-"))), [
      review("r1", 10),
      review("r2", 10),
    ]);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.equal(out.data.agreements.length, 1);
    assert.equal(out.data.unique_findings.length, 0);
  });
});

test("raven compare: missing line does not match a line-specific finding", () => {
  withRepo((repo, head) => {
    const dir = mkdtempSync(join(tmpdir(), "tokenomy-raven-store-"));
    try {
      const out = compareReviews(packet(repo, head), repo, store(dir), [review("r1", 10), review("r2", undefined)]);
      assert.equal(out.ok, true);
      if (!out.ok) return;
      assert.equal(out.data.agreements.length, 0);
      assert.equal(out.data.unique_findings.length, 2);
      assert.equal(out.data.disagreements.length, 2);
      assert.equal(out.data.recommended_action, "investigate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
