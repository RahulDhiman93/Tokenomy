# Code-graph MCP (`tokenomy-graph`)

Stdio MCP server exposing graph tools that replace brute-force `Read` sweeps of the codebase, plus Raven handoff/review tools when Raven is enabled. Works with Claude Code, Codex CLI, Cursor, Windsurf, Cline, Gemini.

## Tools

| Tool | What it does | Budget |
|---|---|---|
| `build_or_update_graph` | Build or refresh the local code graph for the current repo | 4 KB |
| `get_minimal_context` | Smallest useful neighborhood around a file or symbol | 8 KB |
| `get_impact_radius` | Reverse deps + suggested tests for changed files or symbols | 16 KB |
| `get_review_context` | Ranked hotspots + fanout across changed files | 4 KB |
| `find_usages` | Direct callers, references, importers of a file or symbol | 16 KB |
| `find_oss_alternatives` | Repo + branch + package-registry search with distinct-token ranking | 8 KB |
| `create_handoff_packet` | Compact Raven packet — git diff, graph context, session hints | 8 KB |
| `read_handoff_packet` | Read the latest or named Raven packet | 8 KB |
| `record_agent_review` | Persist Claude/Codex/human review findings | 4 KB |
| `list_agent_reviews` | List reviews recorded against a packet | 8 KB |
| `compare_agent_reviews` | Deterministically match findings, surface disagreements | 8 KB |
| `get_pr_readiness` | Apply Raven's merge verdict rules: no, risky, yes | 8 KB |
| `record_decision` | Persist the human merge/fix/investigate decision | 4 KB |

All outputs are budget-clipped per tool. Read-only graph tools are LRU-cached on `(meta.built_at, budget)`.

## Setup

```bash
tokenomy init --graph-path "$PWD"   # registers in every detected agent + builds the graph
```

| Agent | Install target |
|---|---|
| Claude Code | `~/.claude/settings.json` + `~/.claude.json` |
| Codex CLI | `codex mcp add tokenomy-graph ...` + `~/.codex/hooks.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline | `~/.cline/mcp_settings.json` |
| Gemini CLI | `~/.gemini/settings.json` |

`init --list-agents` prints the detection table; `--agent <name>` forces one target; `--no-build` skips the initial graph build.

## Parser

TypeScript / JavaScript AST via the TS compiler (no type checker). `tsconfig.paths` / `jsconfig.paths` resolved (alpha.17+) so `@/hooks/foo` and friends link to real source files on Next.js, Vite, Nuxt, monorepos. Read-side auto-refresh (alpha.15+) rebuilds on demand when files change between queries. Fail-open everywhere.

## Incremental updates (beta.3+)

`cfg.graph.incremental: true` enables delta rebuilds that re-parse only stale files + direct importers. Falls back to full rebuild if tsconfig/exclude fingerprints shift or > 40 % of files changed. Opt-in.

## Live freshness (0.1.3+)

Pre-0.1.3 the graph snapshot only refreshed when the agent invoked a graph MCP tool. Mid-session edits via `Edit` / `Write` / `MultiEdit` / `NotebookEdit` silently drifted it out of date.

0.1.3+ wires three layers:

1. **Dirty sentinel.** PostToolUse on those edit tools touches `~/.tokenomy/graphs/<repo-id>/.dirty` with the changed file path. Cost per edit: one `existsSync` + one small append (~50 B). Skipped when no graph dir exists for the repo (no graph built yet).
2. **Cheap-stale short-circuit.** `isGraphStaleCheap` returns `{ stale: true }` immediately when the sentinel exists — saves the full enumerate-and-stat repo walk on every read-side MCP query. O(repo) → O(1).
3. **Async rebuild.** When the snapshot is stale-but-cached, the read-side serves the cached snapshot AND fires the rebuild in the background (process-local lockset prevents pile-up across rapid agent calls). Caller still receives `stale: true` in the response. The build clears the sentinel on success.

Opt-out: `tokenomy config set graph.async_rebuild false` reverts to the synchronous-await behavior so a doomed rebuild surfaces immediately.

## Cross-repo isolation (0.1.3+)

The MCP server's startup cwd was previously baked into every tool call. When the agent worked across multiple repos in one Claude session, every query returned data for the registered repo regardless of the active one.

0.1.3+ adds an optional `path` arg to every tool's input schema. Pass `path: "$PWD"` (or any absolute repo root) and Tokenomy resolves the per-repo graph + Raven store from that path. Default falls back to the server's startup cwd, so single-repo workflows are unchanged.

Recommended: run `tokenomy init --graph-path "$PWD"` in EACH repo so each Claude Code project window registers its own MCP server bound to its own repo.
