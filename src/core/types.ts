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

// Claude Code fires UserPromptSubmit once per user turn, before the model
// sees the prompt. The hook can inject `additionalContext` that's appended
// to the user's message so the model sees it inline.
export interface UserPromptHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface UserPromptHookOutput {
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit";
    additionalContext: string;
  };
}

// Claude Code fires SessionStart once when a new coding session begins.
// Golem uses this to inject its output-style rules so the whole session
// (not just one turn) runs terse-mode.
export interface SessionStartHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "SessionStart";
  source?: string;
}

export interface SessionStartHookOutput {
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string;
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
  // Bash PostToolUse stack trace compressor. This lives under `mcp` because
  // it shares the post-tool trim gate and savings accounting.
  shell_trace_trim?: ShellTraceTrimConfig;
}

export interface ShellTraceTrimConfig {
  enabled: boolean;
  max_preserved_frames_head: number;
  max_preserved_frames_tail: number;
  min_frames_to_trigger: number;
}

export interface ShapeTrimConfig {
  enabled: boolean;
  max_items: number;
  max_string_bytes: number;
}

// Pre-flight cost gate. When enabled, PreToolUse estimates the response
// size of incoming tool calls from analyze-cache history and appends a
// warning to `additionalContext` if the call would push the session over
// `session_cap_tokens`. Never refuses — PreHookOutput has no reject field.
export interface BudgetConfig {
  enabled: boolean;
  // Per-call warn threshold (tokens). Below this, never warns regardless of
  // session state.
  warn_threshold_tokens: number;
  // Session-wide cumulative cap (tokens). Warn only when running total +
  // estimated > this number.
  session_cap_tokens: number;
  // Tools for which the budget gate always no-ops. Defaults to Read/Write/
  // Edit because those are already clamped/bounded and routinely small.
  exclude_tools: string[];
}

export interface RedactConfig {
  enabled: boolean;
  // Disabled pattern names (e.g. ["jwt"] if users carry many non-secret JWTs).
  disabled_patterns?: string[];
  // PreToolUse redaction for user-initiated tool calls (Bash/Write/Edit).
  // Defaults to false so the first beta-3 tag ships the feature without
  // surprising users; flip to true after one release cycle of real-world
  // validation that redaction doesn't mangle legitimate scripts.
  pre_tool_use?: boolean;
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
  find_oss_alternatives: number;
  create_handoff_packet: number;
  read_handoff_packet: number;
  record_agent_review: number;
  list_agent_reviews: number;
  compare_agent_reviews: number;
  get_pr_readiness: number;
  record_decision: number;
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
  // 0.1.3+: when true (default), a stale-but-existing snapshot is served
  // immediately and the rebuild runs in the background. The caller still
  // gets `stale: true` in the response so the assistant knows the data is
  // not fresh. Set to false to revert to the synchronous-await behavior.
  async_rebuild?: boolean;
  // Beta-3: delta graph builds. When true, the builder compares file
  // content hashes against the prior snapshot and re-parses only changed
  // files. Falls back to a full build when tsconfig/package.json change or
  // when >40% of files differ. Default: false during first beta-3 tag.
  incremental?: boolean;
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
  disable_trace_trim?: boolean;
}

export type OssSearchEcosystem = "npm" | "pypi" | "go" | "maven";

export interface NudgeConfig {
  // Master switch. When false, the MCP tool still exists but the Write-
  // intercept nudge never fires. Default: true.
  enabled: boolean;
  oss_search: {
    // Hard wall-clock cap for registry search / npm CLI fallback. Default: 5000.
    timeout_ms: number;
    // Filter threshold on npm's popularity score proxy. Default: 1000.
    // (Not a true weekly-download count today; npm's popularity score is used
    // as the proxy until we enrich with package-level download data.)
    min_weekly_downloads: number;
    // How many ranked candidates to return at most. Hard-capped at 10.
    // Default: 5.
    max_results: number;
    // Package registries to search when project files don't imply a narrower
    // ecosystem. Default: ["npm"]; project inference adds PyPI/Go/Maven for
    // Python, Go, and JVM repos.
    ecosystems: OssSearchEcosystem[];
  };
  write_intercept: {
    // When false, the PreToolUse Write nudge never fires even if the
    // master `enabled` switch is on. Default: true.
    enabled: boolean;
    // Gitignore-style globs (reuses src/util/glob.ts semantics). Files
    // matching any of these AND exceeding `min_size_bytes` get the nudge.
    paths: string[];
    // Skip nudge when the about-to-be-written content is smaller than this.
    // Filters out tiny stubs / types-only files that aren't real reinvention.
    // Default: 500 bytes.
    min_size_bytes: number;
  };
  // UserPromptSubmit prompt-classifier nudge. Fires once per user turn,
  // BEFORE Claude plans. Classifies the prompt's intent (build / change /
  // remove / review) and injects `additionalContext` pointing at the right
  // `tokenomy-graph` MCP tool. This closes the gap where Write-only nudges
  // miss planning-phase turns ("plan X", "no code") and questions about
  // refactors / removals that never reach a Write.
  prompt_classifier: {
    // Master switch for all prompt-classifier intents. Default: true.
    enabled: boolean;
    // Per-intent toggles — tune down if an intent produces false positives
    // on a particular user's working style.
    intents: {
      build: boolean;      // "build X", "implement Y" → find_oss_alternatives
      change: boolean;     // "refactor", "rename", "migrate" → find_usages + get_impact_radius
      remove: boolean;     // "remove", "delete", "drop" → get_impact_radius
      review: boolean;     // "review", "audit", "what changed" → get_review_context
    };
    // Skip classification on prompts shorter than this — avoids firing on
    // "yes", "go ahead", single-word confirmations. Default: 20 chars.
    min_prompt_chars: number;
  };
}

// Golem: terse-output-mode plugin. Injects assistant-reply style rules at
// SessionStart and reinforces per-turn via UserPromptSubmit. Three modes
// (lite / full / ultra) with a safety gate that NEVER compresses fenced
// code, shell commands, security/auth warnings, or destructive-action
// language. Off by default — opt in via `tokenomy golem enable`.
export interface GolemConfig {
  // Master switch. When false, no SessionStart injection, no per-turn
  // reminder, no output-mode rules. Default: false (opt-in).
  enabled: boolean;
  // Terseness level:
  // - "lite":  drop hedging ("I think", "perhaps"), pleasantries, repeat caveats
  // - "full":  + declarative sentences only, no narration of upcoming steps,
  //            one-sentence conclusions (Hemingway-adjacent)
  // - "ultra": + max 3 non-code lines per reply, single-word confirmations
  //            where possible
  // - "grunt": + drop articles / subject pronouns where meaning survives,
  //            fragments over sentences, occasional playful terseness
  //            ("ship it.", "nope.", "aye."). Caveman-adjacent energy,
  //            still safety-gated.
  // - "recon": + strip fillers/hedges/transitions/conversational hooks,
  //            single-token answers ("ok", "no", "blocked"), key:value or
  //            tabular over prose, imperatives only. Beyond grunt — agent-
  //            in-the-field tone, zero banter, info density only.
  // "auto" resolves at SessionStart from ~/.tokenomy/golem-tune.json
  // (written by `tokenomy analyze --tune`). Falls back to "full" if the
  // tune file doesn't exist yet.
  mode: "lite" | "full" | "ultra" | "grunt" | "recon" | "auto";
  // Always-preserved content carve-outs. Fenced code / shell / security /
  // destructive-action / error-message text is never subject to the style
  // rules. Off this only if you understand the risk.
  safety_gates: boolean;
}

export interface RavenConfig {
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

export interface Config {
  aggression: "conservative" | "balanced" | "aggressive";
  gate: GateConfig;
  mcp: McpRuleConfig;
  read: ReadRuleConfig;
  bash: BashRuleConfig;
  graph: GraphConfig;
  redact: RedactConfig;
  // PreToolUse pre-flight cost gate (beta-3+). Defaults to disabled.
  budget?: BudgetConfig;
  log_path: string;
  disabled_tools: string[];
  // Glob-keyed per-tool overrides. E.g.
  //   "mcp__Atlassian__*": { aggression: "aggressive" }
  tools?: Record<string, PerToolOverride>;
  // Duplicate-response deduplication (session-scoped).
  dedup?: DedupConfig;
  // Hook perf budget (ms). Values above this get flagged in `doctor`.
  perf?: PerfConfig;
  // OSS-alternatives-first nudge — MCP tool + PreToolUse Write intercept.
  // See NudgeConfig. Optional for backwards-compat: legacy config files
  // deserialize fine and pick up defaults via DEFAULT_CONFIG merging.
  nudge?: NudgeConfig;
  // Golem: terse-output-mode plugin (0.1.1-beta.1+). Off by default.
  golem: GolemConfig;
  // Raven: Claude Code-first cross-agent handoff/review packets.
  raven: RavenConfig;
  // Kratos: security shield. Off by default. Continuous prompt scan
  // (UserPromptSubmit) plus on-demand `tokenomy kratos scan` static audit.
  kratos: KratosConfig;
}

export interface KratosConfig {
  enabled: boolean;
  // When true, every UserPromptSubmit prompt is checked for injection /
  // exfil / secret patterns. When false, kratos is purely CLI-driven.
  continuous: boolean;
  categories: {
    "prompt-injection": boolean;
    "data-exfil": boolean;
    "secret-in-prompt": boolean;
    "encoded-payload": boolean;
    "mcp-exfil-pair": boolean;
    "mcp-untrusted-server": boolean;
    "hook-overbroad": boolean;
    "config-drift": boolean;
    "transcript-leak": boolean;
  };
  prompt_min_severity: "info" | "medium" | "high" | "critical";
  notice_max_bytes: number;
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
