# Tokenomy

Transparent token-reduction toolkit for Claude Code.

Long sessions burn tokens on two reliable bloat sources: **bloated MCP tool responses** (Atlassian / Gmail / Notion / Jira can each return tens of kilobytes of JSON) and **oversized `Read` calls** on large source files (Claude's default reads up to 2 000 lines = 15–25 K tokens per call, and agents often do 5–10 reads to understand a module).

Tokenomy plugs into the two hook points the Claude Code contract actually allows, with zero behavioral risk:

1. **`PostToolUse` matcher `mcp__.*`** — transparently trims MCP `content[]` arrays via `hookSpecificOutput.updatedMCPToolOutput`. Text blocks are head+tail trimmed; non-text blocks (images, resources) pass through untouched; a single recovery-hint footer tells Claude how to re-invoke for full detail.
2. **`PreToolUse` matcher `Read`** — when Claude issues an unbounded `Read` on a file over a threshold, injects a `limit` into the tool input via `hookSpecificOutput.updatedInput`. An `additionalContext` note explains the clamp so Claude can `offset`-Read more if it needs.

> **Scope.** Built-in `Bash` / `Grep` / `Glob` output still cannot be transparently trimmed post-hoc — Anthropic restricts `updatedMCPToolOutput` to MCP tools. `PreToolUse` rewriting for those tools is on the roadmap.

## Install (from source)

```bash
git clone <this repo> && cd tokenomy
npm install
npm run build
npm link          # optional — puts `tokenomy` on PATH
```

## Usage

```
tokenomy init [--aggression=conservative|balanced|aggressive] [--no-backup]
tokenomy doctor
tokenomy uninstall [--purge] [--no-backup]
tokenomy config get|set <key> [value]
```

`init` stages the hook binary under `~/.tokenomy/bin/`, patches `~/.claude/settings.json` (backup first), adds **two hook entries** (`PostToolUse` for MCP, `PreToolUse` for `Read`), and writes a default config. Idempotent — re-run any time.

After `init`, **restart Claude Code** so it loads the new settings. Config changes take effect immediately, no restart needed.

## How it works

### MCP trim (PostToolUse)

1. Claude Code runs an MCP tool, e.g. `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql`.
2. The `PostToolUse` hook reads the full response on stdin.
3. If the response matches the MCP `CallToolResult` shape (`{content: [...]}`) or the raw array shape (`[...]`):
   - **Non-text blocks** preserved in their original position.
   - **Text blocks** totalled. If over `mcp.max_text_bytes`, first oversized text block is head+tail trimmed; subsequent text blocks are replaced with a short elision marker.
   - **Footer** appended: `[tokenomy: response trimmed — ~N → ~M bytes. Re-invoke <tool> with narrower parameters if full output needed.]`
4. Claude sees the trimmed version via `updatedMCPToolOutput`; a row appends to `~/.tokenomy/savings.jsonl`.

### Read clamp (PreToolUse)

1. Claude issues a `Read` on a file.
2. The `PreToolUse` hook checks `tool_input`:
   - If `limit` or `offset` is already set → **passthrough** (respect explicit intent).
   - If the file is below `read.clamp_above_bytes` → **passthrough** (small files are fine).
   - Otherwise → inject `limit: read.injected_limit` and `additionalContext` explaining the clamp.
3. The Read actually runs narrower, so fewer tokens enter context. Claude can re-Read with explicit `offset` + `limit` for other regions.

### Schema invariants (tested)

- `content.length` in the MCP output never shrinks — only grows by the footer.
- Non-text blocks keep their relative order and content.
- `is_error` and other unknown top-level keys flow through unchanged.
- `Read` clamp preserves all other `tool_input` fields (`file_path`, etc.).

## Configuration

`~/.tokenomy/config.json` (per-repo override: `./.tokenomy.json`).

```json
{
  "aggression": "conservative",
  "gate": {
    "always_trim_above_bytes": 40000,
    "min_saved_bytes": 4000,
    "min_saved_pct": 0.25
  },
  "mcp": {
    "max_text_bytes": 16000,
    "per_block_head": 4000,
    "per_block_tail": 2000
  },
  "read": {
    "enabled": true,
    "clamp_above_bytes": 40000,
    "injected_limit": 500
  },
  "log_path": "~/.tokenomy/savings.jsonl",
  "disabled_tools": []
}
```

Aggression multiplier scales numeric thresholds: `conservative` × 2 (default), `balanced` × 1, `aggressive` × 0.5. Lower thresholds = more intervention.

Common tweaks:
```bash
tokenomy config set aggression balanced           # remove multiplier
tokenomy config set read.enabled false            # disable just the Read clamp
tokenomy config set read.clamp_above_bytes 20000  # clamp smaller files too
tokenomy config set mcp.max_text_bytes 8000       # trim smaller MCP responses
```

## Measuring savings

Real-time tail:
```bash
tail -f ~/.tokenomy/savings.jsonl
```

Total tokens saved (shell one-liner):
```bash
grep -oE '"tokens_saved_est":[0-9]+' ~/.tokenomy/savings.jsonl \
  | awk -F: '{s+=$2; n++} END{printf "trims: %d  tokens saved (est): %d\n", n, s}'
```

Per-tool breakdown (requires `jq`):
```bash
jq -r '[.tool, .tokens_saved_est] | @tsv' ~/.tokenomy/savings.jsonl \
  | awk '{s[$1]+=$2; c[$1]++} END{for(t in s) printf "%-60s %5d trims  %8d tokens\n", t, c[t], s[t]}' \
  | sort -k4 -nr
```

A debug log at `~/.tokenomy/debug.jsonl` records every hook invocation (trim or passthrough) so you can diagnose matcher / shape issues.

## Fail-open guarantees

The hook's single job is **never break Claude**:
- Malformed stdin, parse errors, unknown response shapes → exit 0 with empty stdout (true passthrough).
- 10 MB stdin cap + 2.5 s internal timeout prevent runaway reads.
- Savings log failures are swallowed.
- Exit code 2 (blocking error) is **never** used.

## `doctor`

Run `tokenomy doctor` any time — nine checks covering Node version, settings parse, both hook entries, binary executability, smoke-spawn latency, config validity, log writability, manifest drift, and overlapping `mcp__.*` hooks from other tools.

## Uninstall

```bash
tokenomy uninstall --purge
```

Removes both hook entries from `~/.claude/settings.json` (matched by command path, not a brittle marker), deletes `~/.tokenomy/`, and leaves an automatic backup of the original `settings.json`.

## Roadmap

- **Phase 2.** `tokenomy analyze` — walks `~/.claude/projects/**/*.jsonl` to benchmark real savings and surface waste patterns. Statusline with live savings counter.
- **Phase 3.** Portable MCP companion server: `tokenomy_summarize`, `tokenomy_read_slice`, `tokenomy_grep_bucketed`. Works in Codex via `~/.codex/config.toml` too.
- **Phase 4.** `PreToolUse` input-bounder for `Bash` (append `| head` to known-verbose commands) + hinting layer that suggests tokenomy MCP alternatives after oversized built-in results.
- **Phase 5.** Polish: real tokenizer, prompt-submit effort nudges, npm publish.

## License

MIT
