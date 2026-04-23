export type RavenAgent = "claude-code" | "codex" | "human";
export type RavenIntent = "review" | "handoff" | "pr-check" | "second-opinion";
export type RavenSeverity = "critical" | "high" | "medium" | "low";
export type RavenVerdict = "pass" | "needs-work" | "risky" | "blocked";
export type RavenDecisionValue = "merge" | "fix-first" | "investigate" | "defer" | "abandon";
export type RavenReady = "yes" | "no" | "risky";

export interface RavenFileStat {
  file: string;
  additions: number;
  deletions: number;
}

export interface RavenDiffEntry {
  file: string;
  patch: string;
  truncated: boolean;
}

export interface RavenPacket {
  schema_version: 1;
  packet_id: string;
  created_at: string;
  repo: {
    root: string;
    repo_id: string;
    branch: string;
    head_sha: string;
    base_ref?: string;
    dirty: boolean;
  };
  source: {
    agent?: RavenAgent;
    session_id?: string;
  };
  target?: {
    agent?: RavenAgent;
    intent?: RavenIntent;
  };
  goal?: string;
  git: {
    staged_files: string[];
    unstaged_files: string[];
    untracked_files: string[];
    changed_files: string[];
    stats: RavenFileStat[];
    diff_summary: RavenDiffEntry[];
    dropped_files: number;
    diff_truncated: boolean;
  };
  graph?: {
    review_context?: unknown;
    impact_radius?: unknown;
  };
  session?: {
    estimated_tokens?: number;
    recent_tools?: Array<{ tool: string; tokens: number }>;
  };
  risks: string[];
  review_focus: string[];
  open_questions: string[];
}

export interface RavenFinding {
  severity: RavenSeverity;
  file?: string;
  line?: number;
  title: string;
  detail: string;
  suggested_fix?: string;
  resolved?: boolean;
}

export interface RavenReview {
  schema_version: 1;
  review_id: string;
  packet_id: string;
  agent: RavenAgent;
  created_at: string;
  verdict: RavenVerdict;
  findings: RavenFinding[];
  questions: string[];
  suggested_tests: string[];
}

export interface RavenComparison {
  schema_version: 1;
  comparison_id: string;
  packet_id: string;
  reviews: string[];
  agreements: RavenFinding[];
  disagreements: RavenFinding[];
  unique_findings: RavenFinding[];
  likely_false_positives: RavenFinding[];
  recommended_action: "merge" | "fix-first" | "investigate" | "rerun";
}

export interface RavenDecision {
  schema_version: 1;
  decision_id: string;
  packet_id: string;
  decision: RavenDecisionValue;
  rationale: string;
  decided_by: RavenAgent;
  review_ids: string[];
  created_at: string;
}

export interface RavenPrReadiness {
  schema_version: 1;
  packet_id: string;
  ready: RavenReady;
  blocking: string[];
  warnings: string[];
  suggested_tests: string[];
  review_count: number;
}

export interface RavenConfigShape {
  enabled: boolean;
  requires_codex: boolean;
  auto_brief: boolean;
  auto_nudge: boolean;
  auto_pr_check: boolean;
  artifact_scope: "global" | "project";
  max_diff_bytes: number;
  max_file_diff_bytes: number;
  max_markdown_bytes: number;
  include_graph_context: boolean;
  include_session_state: boolean;
  review_timeout_ms: number;
  clean_keep: number;
  clean_older_than_days: number;
}

export type RavenResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: string; hint?: string };
