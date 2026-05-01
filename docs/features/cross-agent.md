# Cross-agent install

`tokenomy init --graph-path "$PWD"` auto-detects graph-capable agents and registers `tokenomy-graph` where compatible. Codex CLI gets hooks only; Tokenomy removes older Codex `tokenomy-graph` MCP entries because Codex can hang while probing user MCP servers.

```bash
tokenomy init --list-agents                  # detection table
tokenomy init --agent cursor --graph-path "$PWD"
tokenomy uninstall --agent cursor
```

## Per-agent matrix

| Agent | Hooks | Graph MCP | Install target |
|---|---:|---:|---|
| Claude Code | full | yes | `~/.claude/settings.json` + `~/.claude.json` |
| Codex CLI | partial | no | `~/.codex/hooks.json`; removes older `tokenomy-graph` MCP entry |
| Cursor | — | yes | `~/.cursor/mcp.json` |
| Windsurf | — | yes | `~/.codeium/windsurf/mcp_config.json` |
| Cline | — | yes | `~/.cline/mcp_settings.json` |
| Gemini CLI | — | yes | `~/.gemini/settings.json` |

Per-agent adapter files under `src/cli/agents/`. Detection is non-destructive — each adapter returns `{detected, detail, install()}` based on CLI-binary presence + config-dir presence. Every write is atomic (temp file + rename) with a `.tokenomy-bak-<ts>` backup next to the target. Symmetric uninstall via `tokenomy uninstall --agent=<name>`.

## Codex hooks (beta.3+, partial)

Tokenomy writes user-scoped `~/.codex/hooks.json` for `SessionStart` and `UserPromptSubmit` and enables `features.codex_hooks`. This means Golem and prompt-classifier nudges work in Codex.

Claude-style MCP output mutation, Read input mutation, and Bash input rewriting remain Claude-only until Codex exposes compatible hook contracts.
