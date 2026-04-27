import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderComparisonMarkdown,
  renderDecisionMarkdown,
  renderPacketMarkdown,
  renderReadinessMarkdown,
  renderReviewMarkdown,
} from "../../src/raven/render.js";
import type {
  RavenComparison,
  RavenDecision,
  RavenFinding,
  RavenPacket,
  RavenPrReadiness,
  RavenReview,
} from "../../src/raven/schema.js";

const baseFinding = (over: Partial<RavenFinding> = {}): RavenFinding => ({
  severity: "high",
  title: "race condition in retry loop",
  detail: "two callers can re-enter before the first finishes",
  file: "src/retry.ts",
  line: 42,
  ...over,
});

const basePacket = (over: Partial<RavenPacket> = {}): RavenPacket => ({
  schema_version: 1,
  packet_id: "raven-packet-test",
  created_at: "2026-04-26T00:00:00Z",
  repo: {
    root: "/tmp/repo",
    repo_id: "repoid",
    branch: "feature/x",
    head_sha: "deadbeef",
    dirty: false,
  },
  source: { agent: "claude-code", session_id: "s" },
  target: { agent: "codex", intent: "review" },
  goal: "second-opinion review of retry path",
  git: {
    staged_files: [],
    unstaged_files: [],
    untracked_files: [],
    changed_files: ["src/retry.ts", "src/limiter.ts"],
    stats: [
      { file: "src/retry.ts", additions: 12, deletions: 4 },
      { file: "src/limiter.ts", additions: 0, deletions: 8 },
    ],
    diff_summary: [
      { file: "src/retry.ts", patch: "@@ -1 +1 @@\n-old\n+new\n", truncated: false },
    ],
    dropped_files: 0,
    diff_truncated: false,
  },
  graph: {
    review_context: { ok: true, data: { hotspots: [] } },
    impact_radius: { ok: true, data: { suggested_tests: ["tests/retry.test.ts"] } },
  },
  risks: ["Working tree clean but feature is large"],
  review_focus: ["src/retry.ts"],
  open_questions: ["should backoff cap at 30s or 60s?"],
  ...over,
});

test("renderPacketMarkdown: includes packet id, repo, focus, suggested tests", () => {
  const md = renderPacketMarkdown(basePacket());
  assert.match(md, /# Tokenomy Raven Packet/);
  assert.match(md, /raven-packet-test/);
  assert.match(md, /Branch: `feature\/x`/);
  assert.match(md, /## Changed Files/);
  assert.match(md, /src\/retry\.ts/);
  assert.match(md, /## Review Focus/);
  assert.match(md, /## Risks/);
  assert.match(md, /## Suggested Tests/);
  assert.match(md, /tests\/retry\.test\.ts/);
});

test("renderPacketMarkdown: clips at maxBytes with footer", () => {
  // Force a tiny budget so the clip footer fires.
  const md = renderPacketMarkdown(basePacket(), 200);
  assert.match(md, /\.\.\. \(\+\d+ bytes dropped\)/);
});

test("renderPacketMarkdown: '(none)' fallback for empty changed_files", () => {
  const md = renderPacketMarkdown(
    basePacket({
      git: {
        ...basePacket().git,
        changed_files: [],
        stats: [],
        diff_summary: [],
      },
    }),
  );
  assert.match(md, /## Changed Files\n- \(none\)/);
});

test("renderReviewMarkdown: passes verdict + agent + findings; '(none)' on empty list", () => {
  const review: RavenReview = {
    schema_version: 1,
    review_id: "raven-review-test",
    packet_id: "raven-packet-test",
    agent: "codex",
    created_at: "2026-04-26T00:00:01Z",
    verdict: "needs-work",
    findings: [baseFinding()],
    questions: [],
    suggested_tests: ["tests/retry.test.ts"],
  };
  const md = renderReviewMarkdown(review);
  assert.match(md, /Review: `raven-review-test`/);
  assert.match(md, /Verdict: needs-work/);
  assert.match(md, /Agent: codex/);
  assert.match(md, /race condition in retry loop/);
  // Questions list was empty → "(none)" placeholder.
  assert.match(md, /- \(none\)/);
});

test("renderReviewMarkdown: empty findings still renders a placeholder line", () => {
  const review: RavenReview = {
    schema_version: 1,
    review_id: "rid",
    packet_id: "pid",
    agent: "claude-code",
    created_at: "2026-04-26T00:00:01Z",
    verdict: "pass",
    findings: [],
    questions: [],
    suggested_tests: [],
  };
  const md = renderReviewMarkdown(review);
  assert.match(md, /Verdict: pass/);
  // All three list sections fall back to "(none)".
  assert.equal((md.match(/- \(none\)/g) ?? []).length >= 1, true);
});

test("renderComparisonMarkdown: agreements / disagreements / unique sections", () => {
  const cmp: RavenComparison = {
    schema_version: 1,
    comparison_id: "cmpid",
    packet_id: "pid",
    reviews: ["r1", "r2"],
    agreements: [baseFinding({ title: "concur: missing null guard" })],
    disagreements: [],
    unique_findings: [baseFinding({ title: "only-codex: timing window" })],
    likely_false_positives: [],
    recommended_action: "fix-first",
  };
  const md = renderComparisonMarkdown(cmp);
  assert.match(md, /concur: missing null guard/);
  assert.match(md, /only-codex: timing window/);
  assert.match(md, /fix-first/);
  // Empty disagreements section → placeholder.
  assert.match(md, /- \(none\)/);
});

test("renderReadinessMarkdown: blocking + warnings + review count", () => {
  const r: RavenPrReadiness = {
    schema_version: 1,
    packet_id: "pid",
    ready: "no",
    blocking: ["unresolved critical finding: missing null guard"],
    warnings: ["graph snapshot is stale"],
    suggested_tests: ["tests/null-guard.test.ts"],
    review_count: 2,
  };
  const md = renderReadinessMarkdown(r);
  assert.match(md, /Ready: no/);
  assert.match(md, /Reviews: 2/);
  assert.match(md, /unresolved critical finding/);
  assert.match(md, /graph snapshot is stale/);
});

test("renderDecisionMarkdown: includes decision label + rationale + reviewers", () => {
  const d: RavenDecision = {
    schema_version: 1,
    decision_id: "did",
    packet_id: "pid",
    decision: "merge",
    rationale: "All findings resolved; coverage is clean.",
    decided_by: "human",
    review_ids: ["r1", "r2"],
    created_at: "2026-04-26T00:00:02Z",
  };
  const md = renderDecisionMarkdown(d);
  assert.match(md, /Value: merge/);
  assert.match(md, /coverage is clean/);
  assert.match(md, /By: human/);
});
