# Configure

`~/.tokenomy/config.json` (per-repo override: `./.tokenomy.json`). Config changes take effect **immediately** — only the initial `init` requires a Claude Code restart.

```jsonc
{
  "aggression": "conservative",        // ×2 thresholds. balanced=×1, aggressive=×0.5
  "gate": {
    "always_trim_above_bytes": 40000,  // huge responses: always trim
    "min_saved_bytes":          4000,  // tiny savings: not worth the context-switch
    "min_saved_pct":            0.25   // percentage floor otherwise
  },
  "mcp": {
    "max_text_bytes":     16000,
    "per_block_head":      4000,
    "per_block_tail":      2000,
    "profiles":              [],
    "disabled_profiles":     [],
    "shape_trim": {
      "enabled":          true,
      "max_items":          50,
      "max_string_bytes":  200
    },
    "shell_trace_trim": {
      "enabled": true,
      "max_preserved_frames_head": 3,
      "max_preserved_frames_tail": 2,
      "min_frames_to_trigger": 6
    }
  },
  "read": {
    "enabled":                     true,
    "clamp_above_bytes":          40000,
    "injected_limit":               500,
    "doc_passthrough_extensions": [".md", ".mdx", ".rst", ".txt", ".adoc"],
    "doc_passthrough_max_bytes":  64000
  },
  "redact": {
    "enabled":            true,
    "pre_tool_use":      false,
    "disabled_patterns":    []
  },
  "dedup": {
    "enabled":            true,
    "min_bytes":          2000,
    "window_seconds":    1800
  },
  "nudge": {
    "enabled": true,
    "oss_search": {
      "timeout_ms":            5000,
      "min_weekly_downloads":  1000,
      "max_results":              5,
      "ecosystems":          ["npm"]
    },
    "write_intercept": {
      "enabled": true,
      "paths": [
        "src/utils/**", "src/util/**", "src/lib/**",
        "src/hooks/**", "src/helpers/**", "src/services/**",
        "src/parsers/**", "src/validators/**", "src/formatters/**",
        "src/middleware/**",
        "pkg/**", "internal/**", "cmd/**",
        "**/utils/**", "**/util/**", "**/helpers/**", "**/validators/**",
        "src/main/java/**", "src/test/java/**"
      ],
      "min_size_bytes": 500
    },
    "prompt_classifier": {
      "enabled": true,
      "intents": { "build": true, "change": true, "remove": true, "review": true },
      "min_prompt_chars": 20
    }
  },
  "golem": {
    "enabled": false,
    "mode": "full",
    "safety_gates": true
  },
  "kratos": {
    "enabled": false,
    "continuous": true,
    "categories": {
      "prompt-injection": true,
      "data-exfil": true,
      "secret-in-prompt": true,
      "encoded-payload": true,
      "mcp-exfil-pair": true,
      "mcp-untrusted-server": true,
      "hook-overbroad": true,
      "config-drift": true,
      "transcript-leak": true
    },
    "prompt_min_severity": "high",
    "notice_max_bytes": 1200
  },
  "raven": {
    "enabled": false,
    "requires_codex": true,
    "auto_brief": true,
    "auto_nudge": true,
    "auto_pr_check": true,
    "artifact_scope": "global",
    "max_diff_bytes": 24000,
    "max_file_diff_bytes": 6000,
    "max_markdown_bytes": 12000,
    "include_graph_context": true,
    "include_session_state": true,
    "review_timeout_ms": 90000,
    "clean_keep": 20,
    "clean_older_than_days": 14
  },
  "tools": {
    "mcp__Atlassian__*": { "aggression": "aggressive" },
    "mcp__Linear__*":    { "disable_profiles": true }
  },
  "perf":   { "p95_budget_ms": 50, "sample_size": 100 },
  "report": { "price_per_million": 3.0 },
  "log_path":       "~/.tokenomy/savings.jsonl",
  "disabled_tools": []
}
```

## Common tweaks

```bash
tokenomy config set aggression aggressive             # trim harder
tokenomy config set read.enabled false                # leave Read alone
tokenomy config set read.clamp_above_bytes 20000      # clamp 20 KB+ files
tokenomy config set mcp.max_text_bytes 8000           # tighter MCP budget
tokenomy config set dedup.window_seconds 600          # 10-min dedup window
tokenomy config set redact.enabled false              # opt out of redaction
tokenomy config set nudge.write_intercept.enabled false # disable Write nudges
tokenomy config set nudge.prompt_classifier.enabled false # disable prompt nudges
tokenomy config set nudge.oss_search.max_results 8    # return more OSS candidates
tokenomy config set golem.mode auto                   # auto-tune from analyze
tokenomy config set kratos.enabled true               # enable security shield
tokenomy config set kratos.prompt_min_severity medium # surface medium+ on every turn
tokenomy config set kratos.categories.encoded-payload false # silence base64 noise
```

## Caller opt-out

An agent that knows it needs the full response can pass `{"_tokenomy": "full", ...real_args}` in the MCP tool input — the pipeline skips every stage. Safer fallback: set `tools: {"<glob>": {"disable_profiles": true}}` for the specific tool (works even with strict MCP servers that reject unknown keys).
