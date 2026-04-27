import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDecision, recordReview } from "../../src/raven/review.js";
import { savePacket, ravenStoreForRepo } from "../../src/raven/store.js";
import { collectGitState } from "../../src/raven/git.js";
import type { RavenPacket } from "../../src/raven/schema.js";

const runGit = (cwd: string, args: string[]): void => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
};

// Build a real git repo so assertPacketFresh's git rev-parse HEAD path works.
const initRepo = (): { repo: string; head: string; cleanup: () => void } => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-raven-review-"));
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.name", "Test"]);
  runGit(repo, ["config", "user.email", "t@x.test"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
  return { repo, head, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
};

const buildPacket = (head: string, root: string): RavenPacket => ({
  schema_version: 1,
  packet_id: "raven-packet-test",
  created_at: "2026-04-26T00:00:00Z",
  repo: { root, repo_id: "rid", branch: "main", head_sha: head, dirty: false },
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

test("recordReview: writes a review when packet head matches HEAD", () => {
  const { repo, head, cleanup } = initRepo();
  try {
    const state = collectGitState(repo);
    assert.equal(state.ok, true);
    if (!state.ok) return;
    const store = ravenStoreForRepo(state.data.repo_id);
    try {
      const packet = buildPacket(head, repo);
      savePacket(store, packet, "# md");
      const r = recordReview({
        packet,
        cwd: repo,
        store,
        agent: "codex",
        verdict: "needs-work",
        findings: [
          {
            severity: "high",
            title: "race condition",
            detail: "two callers can re-enter",
          },
        ],
        questions: ["should we lock?"],
        suggested_tests: ["tests/race.test.ts"],
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.data.verdict, "needs-work");
      assert.equal(r.data.findings.length, 1);
      assert.equal(r.data.questions[0], "should we lock?");
      assert.match(r.data.review_id, /^raven-review-/);
    } finally {
      // best-effort cleanup of the per-repo raven store
      try {
        rmSync(store.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    cleanup();
  }
});

test("recordReview: refuses stale packet (head sha mismatch)", () => {
  const { repo, head, cleanup } = initRepo();
  try {
    const state = collectGitState(repo);
    assert.equal(state.ok, true);
    if (!state.ok) return;
    const store = ravenStoreForRepo(state.data.repo_id);
    try {
      // Flip a single hex char so the packet's recorded HEAD no longer matches.
      const stale = head.replace(/.$/, head.endsWith("0") ? "1" : "0");
      const packet = buildPacket(stale, repo);
      savePacket(store, packet, "# stale");
      const r = recordReview({
        packet,
        cwd: repo,
        store,
        agent: "codex",
        verdict: "pass",
      });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.reason, "stale-packet");
    } finally {
      try {
        rmSync(store.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    cleanup();
  }
});

test("recordDecision: requires referenced review_ids to exist; otherwise review-not-found", () => {
  const { repo, head, cleanup } = initRepo();
  try {
    const state = collectGitState(repo);
    assert.equal(state.ok, true);
    if (!state.ok) return;
    const store = ravenStoreForRepo(state.data.repo_id);
    try {
      const packet = buildPacket(head, repo);
      savePacket(store, packet, "# md");
      const decision = recordDecision({
        packet,
        cwd: repo,
        store,
        decision: "merge",
        rationale: "tests green",
        decided_by: "human",
        review_ids: ["does-not-exist"],
      });
      assert.equal(decision.ok, false);
      if (!decision.ok) assert.equal(decision.reason, "review-not-found");
    } finally {
      try {
        rmSync(store.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    cleanup();
  }
});

test("recordDecision: writes decision when reviews exist + head matches", () => {
  const { repo, head, cleanup } = initRepo();
  try {
    const state = collectGitState(repo);
    assert.equal(state.ok, true);
    if (!state.ok) return;
    const store = ravenStoreForRepo(state.data.repo_id);
    try {
      const packet = buildPacket(head, repo);
      savePacket(store, packet, "# md");
      const review = recordReview({
        packet,
        cwd: repo,
        store,
        agent: "codex",
        verdict: "pass",
      });
      assert.equal(review.ok, true);
      if (!review.ok) return;
      const decision = recordDecision({
        packet,
        cwd: repo,
        store,
        decision: "merge",
        rationale: "all clear",
        decided_by: "human",
        review_ids: [review.data.review_id],
      });
      assert.equal(decision.ok, true);
      if (decision.ok) assert.equal(decision.data.decision, "merge");
    } finally {
      try {
        rmSync(store.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } finally {
    cleanup();
  }
});
