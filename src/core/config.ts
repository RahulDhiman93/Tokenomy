import { readFileSync, existsSync } from "node:fs";
import type { Config, PerToolOverride } from "./types.js";
import { globalConfigPath, projectConfigPath, defaultLogPath, expandHome } from "./paths.js";

export const DEFAULT_CONFIG: Config = {
  aggression: "conservative",
  gate: {
    always_trim_above_bytes: 40_000,
    min_saved_bytes: 4_000,
    min_saved_pct: 0.25,
  },
  mcp: {
    max_text_bytes: 16_000,
    per_block_head: 4_000,
    per_block_tail: 2_000,
    shape_trim: {
      enabled: true,
      max_items: 50,
      max_string_bytes: 200,
    },
    shell_trace_trim: {
      enabled: true,
      max_preserved_frames_head: 3,
      max_preserved_frames_tail: 2,
      min_frames_to_trigger: 6,
    },
  },
  read: {
    enabled: true,
    clamp_above_bytes: 40_000,
    injected_limit: 500,
    doc_passthrough_extensions: [".md", ".mdx", ".rst", ".txt", ".adoc"],
    doc_passthrough_max_bytes: 64_000,
  },
  bash: {
    enabled: true,
    // unscaled base; conservative ×2 → 200 lines default out of the box.
    head_limit: 100,
    min_command_length: 3,
    custom_verbose: [],
    disabled_commands: [],
  },
  graph: {
    enabled: true,
    max_files: 2_000,
    hard_max_files: 5_000,
    build_timeout_ms: 30_000,
    max_edges_per_file: 1_000,
    max_snapshot_bytes: 20_000_000,
    query_budget_bytes: {
      // Build summary is a fixed small payload — 4KB is plenty.
      build_or_update_graph: 4_000,
      // Neighborhood dumps at depth 1-2 can enumerate 20-50 neighbors on a
      // widely-imported module; 8KB covers typical real-world hubs.
      get_minimal_context: 8_000,
      // Reverse deps on a hot symbol (e.g. a widely-used hook or utility)
      // commonly exceed 30 entries at depth 2. 16KB fits ~150 entries.
      get_impact_radius: 16_000,
      // Fanout summary + hotspots — 4KB fits a reasonable review set.
      get_review_context: 4_000,
      // find_usages on a popular export (a shared hook, helper, or type)
      // routinely returns 20-50+ usages in real repos. 16KB fits ~100
      // entries without clipping, matching limitByCount(callSites, 100).
      find_usages: 16_000,
      // find_oss_alternatives returns repo/branch matches plus up to 10
      // package candidates (~600-800 bytes each with ranking + fit_reason).
      // 8KB leaves headroom for the summary + hint fields without clipping.
      find_oss_alternatives: 8_000,
      create_handoff_packet: 12_000,
      read_handoff_packet: 12_000,
      record_agent_review: 8_000,
      list_agent_reviews: 8_000,
      compare_agent_reviews: 8_000,
      get_pr_readiness: 8_000,
      record_decision: 4_000,
    },
    exclude: [
      "**/*.min.js",
      "**/*.min.cjs",
      "**/*.min.mjs",
      "**/*-min.js",
      "**/*-min.cjs",
      "**/*-min.mjs",
      "**/*.bundle.js",
      "**/*.bundle.cjs",
      "**/*.bundle.mjs",
      "**/*-bundle.js",
      "**/*-bundle.cjs",
      "**/*-bundle.mjs",
    ],
    auto_refresh_on_read: true,
    async_rebuild: true,
    incremental: false,
    tsconfig: {
      enabled: true,
    },
  },
  redact: {
    enabled: true,
    pre_tool_use: false,
  },
  budget: {
    enabled: false,
    warn_threshold_tokens: 5_000,
    session_cap_tokens: 150_000,
    exclude_tools: ["Read", "Write", "Edit"],
  },
  log_path: defaultLogPath(),
  disabled_tools: [],
  tools: {},
  dedup: {
    enabled: true,
    min_bytes: 2_000,
    window_seconds: 1_800,
  },
  perf: {
    p95_budget_ms: 50,
    sample_size: 100,
  },
  golem: {
    enabled: false,
    mode: "full",
    safety_gates: true,
  },
  raven: {
    enabled: false,
    requires_codex: true,
    auto_brief: true,
    auto_nudge: true,
    auto_pr_check: true,
    artifact_scope: "global",
    max_diff_bytes: 24_000,
    max_file_diff_bytes: 6_000,
    max_markdown_bytes: 12_000,
    include_graph_context: true,
    include_session_state: true,
    review_timeout_ms: 90_000,
    clean_keep: 20,
    clean_older_than_days: 14,
  },
  kratos: {
    enabled: false,
    continuous: true,
    categories: {
      "prompt-injection": true,
      "data-exfil": true,
      "secret-in-prompt": true,
      "encoded-payload": true,
      "mcp-exfil-pair": true,
      "mcp-untrusted-server": true,
      "hook-overbroad": true,
      "config-drift": true,
      "transcript-leak": true,
    },
    prompt_min_severity: "high",
    notice_max_bytes: 1200,
  },
  nudge: {
    enabled: true,
    oss_search: {
      timeout_ms: 5_000,
      min_weekly_downloads: 1_000,
      max_results: 5,
      ecosystems: ["npm"],
    },
    write_intercept: {
      enabled: true,
      // Common "utility-ish" globs across JS/TS, Python, Go, and Java repos.
      // Users can override via
      // `tokenomy config set nudge.write_intercept.paths '[...]'`.
      paths: [
        "src/utils/**",
        "src/util/**",
        "src/lib/**",
        "src/hooks/**",
        "src/helpers/**",
        "src/services/**",
        "src/parsers/**",
        "src/validators/**",
        "src/formatters/**",
        "src/middleware/**",
        "pkg/**",
        "internal/**",
        "cmd/**",
        "**/utils/**",
        "**/util/**",
        "**/helpers/**",
        "**/validators/**",
        "**/utils.py",
        "**/util.py",
        "**/helpers.py",
        "**/validators.py",
        "**/parsers.py",
        "**/formatters.py",
        "**/middleware.py",
        "**/services.py",
        "src/main/java/**",
        "src/test/java/**",
      ],
      min_size_bytes: 500,
    },
    prompt_classifier: {
      enabled: true,
      intents: {
        build: true,
        change: true,
        remove: true,
        review: true,
      },
      min_prompt_chars: 20,
    },
  },
};

const AGGRESSION_MULT: Record<Config["aggression"], number> = {
  conservative: 2,
  balanced: 1,
  aggressive: 0.5,
};

const readJsonIfExists = (path: string): unknown => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const deepMerge = (
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const baseVal = out[k];
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      out[k] = deepMerge(
        baseVal as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
};

const applyAggression = (cfg: Config): Config => {
  const m = AGGRESSION_MULT[cfg.aggression] ?? 1;
  if (m === 1) return cfg;
  return {
    ...cfg,
    gate: {
      always_trim_above_bytes: Math.round(cfg.gate.always_trim_above_bytes * m),
      min_saved_bytes: Math.round(cfg.gate.min_saved_bytes * m),
      min_saved_pct: cfg.gate.min_saved_pct,
    },
    mcp: {
      max_text_bytes: Math.round(cfg.mcp.max_text_bytes * m),
      per_block_head: Math.round(cfg.mcp.per_block_head * m),
      per_block_tail: Math.round(cfg.mcp.per_block_tail * m),
      profiles: cfg.mcp.profiles,
      disabled_profiles: cfg.mcp.disabled_profiles,
      shape_trim: cfg.mcp.shape_trim
        ? {
            enabled: cfg.mcp.shape_trim.enabled,
            max_items: cfg.mcp.shape_trim.max_items,
            max_string_bytes: Math.max(
              60,
              Math.round(cfg.mcp.shape_trim.max_string_bytes * m),
            ),
          }
        : undefined,
      shell_trace_trim: cfg.mcp.shell_trace_trim,
    },
    read: {
      enabled: cfg.read.enabled,
      // Both scale with m: conservative (×2) is less aggressive (higher threshold,
      // larger injected limit). Aggressive (×0.5) is stricter on both.
      clamp_above_bytes: Math.round(cfg.read.clamp_above_bytes * m),
      injected_limit: Math.max(50, Math.round(cfg.read.injected_limit * m)),
      doc_passthrough_extensions: cfg.read.doc_passthrough_extensions,
      doc_passthrough_max_bytes: Math.round(cfg.read.doc_passthrough_max_bytes * m),
    },
    bash: {
      ...cfg.bash,
      // head_limit clamps into the same validation band the rule enforces.
      head_limit: Math.max(20, Math.min(10_000, Math.round(cfg.bash.head_limit * m))),
    },
    graph: {
      ...cfg.graph,
      build_timeout_ms: Math.max(1_000, Math.round(cfg.graph.build_timeout_ms * m)),
      query_budget_bytes: {
        build_or_update_graph: Math.max(
          512,
          Math.round(cfg.graph.query_budget_bytes.build_or_update_graph * m),
        ),
        get_minimal_context: Math.max(
          512,
          Math.round(cfg.graph.query_budget_bytes.get_minimal_context * m),
        ),
        get_impact_radius: Math.max(
          512,
          Math.round(cfg.graph.query_budget_bytes.get_impact_radius * m),
        ),
        get_review_context: Math.max(
          512,
          Math.round(cfg.graph.query_budget_bytes.get_review_context * m),
        ),
        find_usages: Math.max(
          512,
          Math.round(cfg.graph.query_budget_bytes.find_usages * m),
        ),
        find_oss_alternatives: Math.max(
          512,
          Math.round(cfg.graph.query_budget_bytes.find_oss_alternatives * m),
        ),
        create_handoff_packet: Math.max(512, Math.round(cfg.graph.query_budget_bytes.create_handoff_packet * m)),
        read_handoff_packet: Math.max(512, Math.round(cfg.graph.query_budget_bytes.read_handoff_packet * m)),
        record_agent_review: Math.max(512, Math.round(cfg.graph.query_budget_bytes.record_agent_review * m)),
        list_agent_reviews: Math.max(512, Math.round(cfg.graph.query_budget_bytes.list_agent_reviews * m)),
        compare_agent_reviews: Math.max(512, Math.round(cfg.graph.query_budget_bytes.compare_agent_reviews * m)),
        get_pr_readiness: Math.max(512, Math.round(cfg.graph.query_budget_bytes.get_pr_readiness * m)),
        record_decision: Math.max(512, Math.round(cfg.graph.query_budget_bytes.record_decision * m)),
      },
    },
  };
};

// Case-insensitive to match the profile glob behaviour — keeps per-tool
// overrides portable between Claude Code's CamelCase names and Codex's
// lowercase snake_case variants of the same MCP tool.
const globToRegex = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
};

// Find the most specific tool override (longest non-wildcard pattern wins).
export const resolveToolOverride = (
  cfg: Config,
  toolName: string,
): PerToolOverride | undefined => {
  if (!cfg.tools) return undefined;
  const matches: { pattern: string; override: PerToolOverride; score: number }[] = [];
  for (const [pattern, override] of Object.entries(cfg.tools)) {
    if (globToRegex(pattern).test(toolName)) {
      matches.push({
        pattern,
        override,
        score: pattern.replace(/\*/g, "").length,
      });
    }
  }
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => b.score - a.score);
  return matches[0]!.override;
};

// Derive an effective Config for a specific tool by merging per-tool overrides
// into the base. Currently only `aggression` cascades through applyAggression;
// booleans like disable_dedup are read directly from the override.
export const configForTool = (cfg: Config, toolName: string): Config => {
  const ov = resolveToolOverride(cfg, toolName);
  if (!ov || !ov.aggression || ov.aggression === cfg.aggression) return cfg;
  // Re-apply aggression scaling with the overridden level.
  // We undo current scaling by loading DEFAULT_CONFIG numbers, merging user
  // overrides, and re-applying. Simpler: just rebuild from the default schema
  // with the new aggression.
  const base: Config = { ...cfg, aggression: ov.aggression };
  // Reset gate/mcp/read to DEFAULT_CONFIG (aggression scaling is always applied
  // on top of DEFAULT_CONFIG values to avoid compounding).
  const undone: Config = {
    ...base,
    gate: { ...DEFAULT_CONFIG.gate },
    mcp: {
      ...DEFAULT_CONFIG.mcp,
      profiles: cfg.mcp.profiles,
      disabled_profiles: cfg.mcp.disabled_profiles,
      shape_trim: cfg.mcp.shape_trim,
      shell_trace_trim: cfg.mcp.shell_trace_trim,
    },
    read: { ...DEFAULT_CONFIG.read },
  };
  return applyAggression(undone);
};

export const loadConfig = (cwd: string): Config => {
  const global = readJsonIfExists(globalConfigPath()) as Partial<Config> | undefined;
  const project = readJsonIfExists(projectConfigPath(cwd)) as Partial<Config> | undefined;

  let merged: Record<string, unknown> = { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>;
  if (global && typeof global === "object") {
    merged = deepMerge(merged, global as Record<string, unknown>);
  }
  if (project && typeof project === "object") {
    merged = deepMerge(merged, project as Record<string, unknown>);
  }

  const finalCfg = merged as unknown as Config;
  return applyAggression({ ...finalCfg, log_path: expandHome(finalCfg.log_path) });
};
