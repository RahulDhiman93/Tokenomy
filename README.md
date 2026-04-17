# Tokenomy

Transparent MCP tool-output trimmer for Claude Code.

Long Claude Code sessions burn tokens on bloated MCP responses (Atlassian, Gmail, Notion, etc. often return tens of kilobytes of JSON). Tokenomy intercepts `PostToolUse` for tools matching `mcp__.*` and trims the text content *before* it lands in Claude's context — with a recovery hint so Claude can re-invoke with narrower parameters when it needs detail.

> ⚠️ **Scope.** Phase 1 trims **MCP tool responses only**. The Claude Code hook contract explicitly restricts `updatedMCPToolOutput` to MCP tools — built-in `Bash`/`Read`/`Grep`/`Glob` cannot be trimmed post-hoc. Coverage for built-ins (via `PreToolUse.updatedInput` and hinting) is slated for a later phase.

## Install (from source)

```
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

`init` stages the hook binary under `~/.tokenomy/bin/`, patches `~/.claude/settings.json` (backup first), and writes a default config. Idempotent; re-run any time.

## How it works

1. Claude Code runs an MCP tool, e.g. `mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql`.
2. The `PostToolUse` hook fires with the tool's full response JSON on stdin.
3. `tokenomy-hook` reads the response, inspects `content[]`:
   - **Non-text blocks** (images, resources) are preserved in their original position.
   - **Text blocks** are totalled. If the combined UTF-8 byte count exceeds `mcp.max_text_bytes`, the first oversized text block is head+tail trimmed; subsequent text blocks are replaced with a short elision marker.
   - A final **hint footer** is appended: `[tokenomy: response trimmed — ~N → ~M bytes. Re-invoke <tool> with narrower parameters if full output needed.]`
4. The hook emits `hookSpecificOutput.updatedMCPToolOutput` — Claude receives the trimmed version.
5. A row is appended to `~/.tokenomy/savings.jsonl` with bytes-in/out and estimated tokens saved.

Schema invariants:
- `content.length` never shrinks — it only grows by the hint footer.
- Non-text blocks keep their relative order and content.
- `is_error` and other unknown top-level keys flow through unchanged.

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
  "log_path": "~/.tokenomy/savings.jsonl",
  "disabled_tools": []
}
```

Aggression multiplier scales the numeric thresholds: `conservative` × 2 (default), `balanced` × 1, `aggressive` × 0.5. Lower thresholds trim more aggressively.

## Fail-open guarantees

The hook's single job is *never break Claude*:
- Malformed stdin, parse errors, unknown shapes → exit 0 with empty stdout (true passthrough).
- 10 MB stdin cap + 2.5 s internal timeout prevent runaway reads.
- Savings log failures are swallowed.

## Uninstall

```
tokenomy uninstall --purge
```

Removes the hook entry from `~/.claude/settings.json` (matched by command path, not by brittle markers) and deletes `~/.tokenomy/`.

## Roadmap

- **Phase 2.** `tokenomy analyze` over `~/.claude/projects/**/*.jsonl` — benchmark real savings, surface waste patterns. Statusline with live savings counter.
- **Phase 3.** Portable MCP companion server: `tokenomy_summarize`, `tokenomy_read_slice`, `tokenomy_grep_bucketed`. Works in Codex (`~/.codex/config.toml`) too.
- **Phase 4.** `PreToolUse` input-bounder for `Bash` + hinting layer for built-ins.
- **Phase 5.** Polish, real tokenizer, npm publish.

## License

MIT
