export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; [k: string]: unknown }
  | { type: "resource"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export type McpToolResponse = {
  content?: McpContentBlock[];
  is_error?: boolean;
  [k: string]: unknown;
};

export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  tool_response: unknown;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    updatedMCPToolOutput: McpToolResponse;
  };
}

export interface PreHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PreHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    updatedInput: Record<string, unknown>;
    additionalContext?: string;
  };
}

export type RuleResult =
  | { kind: "passthrough" }
  | {
      kind: "trim";
      output: McpToolResponse;
      bytesIn: number;
      bytesOut: number;
      reason: string;
    };

export type Rule = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  cfg: Config,
) => RuleResult;

export interface GateConfig {
  always_trim_above_bytes: number;
  min_saved_bytes: number;
  min_saved_pct: number;
}

export interface McpRuleConfig {
  max_text_bytes: number;
  per_block_head: number;
  per_block_tail: number;
  // Optional: additional user trim profiles (merged with BUILTIN_PROFILES).
  // Empty / undefined → use built-ins only.
  profiles?: import("../rules/profiles.js").TrimProfile[];
  // Disable built-in profiles by name if a user wants to override them with
  // their own version without mutating the array from the CLI.
  disabled_profiles?: string[];
  // Shape-aware fallback between profile match and byte trim. Kicks in for
  // unprofiled inventory-shaped JSON responses (arrays of homogeneous
  // records or {transitions|issues|values|results: [...]}) where head+tail
  // byte trimming would destroy row structure.
  shape_trim?: ShapeTrimConfig;
}

export interface ShapeTrimConfig {
  enabled: boolean;
  max_items: number;
  max_string_bytes: number;
}

export interface RedactConfig {
  enabled: boolean;
  // Disabled pattern names (e.g. ["jwt"] if users carry many non-secret JWTs).
  disabled_patterns?: string[];
}

export interface ReadRuleConfig {
  enabled: boolean;
  clamp_above_bytes: number;
  injected_limit: number;
  // Files with these extensions (lowercase, incl. leading dot) passthrough
  // unclamped when their size is <= doc_passthrough_max_bytes. Self-contained
  // docs (READMEs, changelogs) read poorly when clamped — the agent wants the
  // whole thing in one shot, not offset-paged.
  doc_passthrough_extensions: string[];
  doc_passthrough_max_bytes: number;
}

export interface BashRuleConfig {
  enabled: boolean;
  // Line cap appended to bounded commands. Validated as an integer in
  // [20, 10_000] at rule-execution time; anything outside that band or
  // not an integer degrades to a passthrough (never interpolated into
  // shell as-is).
  head_limit: number;
  // Minimum command length before the rule considers injection.
  min_command_length: number;
  // Extra user-defined verbose prefixes (e.g. "flamegraph") treated the
  // same as the built-in list. Matched as a literal prefix up to the
  // next whitespace, case-sensitive.
  custom_verbose: string[];
  // Built-in pattern names (e.g. "git-log", "find") to exclude from
  // bounding — escape hatch when a user wants full output for a specific
  // command the heuristic would otherwise catch.
  disabled_commands: string[];
}

export interface GraphQueryBudgetConfig {
  build_or_update_graph: number;
  get_minimal_context: number;
  get_impact_radius: number;
  get_review_context: number;
  find_usages: number;
}

export interface GraphConfig {
  enabled: boolean;
  max_files: number;
  hard_max_files: number;
  build_timeout_ms: number;
  max_edges_per_file: number;
  max_snapshot_bytes: number;
  query_budget_bytes: GraphQueryBudgetConfig;
  exclude: string[];
  auto_refresh_on_read: boolean;
  tsconfig: {
    // When true, the graph builder resolves import specifiers through the
    // nearest tsconfig.json / jsconfig.json `paths` + `baseUrl` (honors
    // `extends` chains, including `@tsconfig/*` bases from node_modules).
    // Covers aliases like `@/`, `~/`, `@@/`, `@app/` etc. When false, all
    // non-relative imports fall back to external-module nodes (pre-alpha.17
    // behavior). Default: true.
    enabled: boolean;
  };
}

export interface PerToolOverride {
  aggression?: "conservative" | "balanced" | "aggressive";
  disable_dedup?: boolean;
  disable_redact?: boolean;
  disable_profiles?: boolean;
  disable_stacktrace?: boolean;
}

export interface Config {
  aggression: "conservative" | "balanced" | "aggressive";
  gate: GateConfig;
  mcp: McpRuleConfig;
  read: ReadRuleConfig;
  bash: BashRuleConfig;
  graph: GraphConfig;
  redact: RedactConfig;
  log_path: string;
  disabled_tools: string[];
  // Glob-keyed per-tool overrides. E.g.
  //   "mcp__Atlassian__*": { aggression: "aggressive" }
  tools?: Record<string, PerToolOverride>;
  // Duplicate-response deduplication (session-scoped).
  dedup?: DedupConfig;
  // Hook perf budget (ms). Values above this get flagged in `doctor`.
  perf?: PerfConfig;
}

export interface DedupConfig {
  enabled: boolean;
  min_bytes: number;
  // Window within a session during which a repeat is considered a duplicate.
  window_seconds: number;
}

export interface PerfConfig {
  p95_budget_ms: number;
  sample_size: number;
}

export interface SavingsLogEntry {
  ts: string;
  session_id: string;
  tool: string;
  bytes_in: number;
  bytes_out: number;
  tokens_saved_est: number;
  reason: string;
}

export interface ManifestEntry {
  command_path: string;
  settings_path: string;
  matcher: string;
  installed_at: string;
}

export interface Manifest {
  version: 1;
  entries: ManifestEntry[];
}
