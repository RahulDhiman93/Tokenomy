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
tokenomy init --graph-path "$PWD"   # registers graph MCP where compatible + builds the graph
```

| Agent | Install target |
|---|---|
| Claude Code | `~/.claude/settings.json` + `~/.claude.json` |
| Codex CLI | `~/.codex/hooks.json` only; Codex MCP auto-registration is skipped |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline | `~/.cline/mcp_settings.json` |
| Gemini CLI | `~/.gemini/settings.json` |

`init --list-agents` prints the detection table; `--agent <name>` forces one target; `--no-build` skips the initial graph build.

## Parser

TypeScript / JavaScript AST via the TS compiler (no type checker). `tsconfig.paths` / `jsconfig.paths` resolved (alpha.17+) so `@/hooks/foo` and friends link to real source files on Next.js, Vite, Nuxt, monorepos. Read-side auto-refresh (alpha.15+) rebuilds on demand when files change between queries. Fail-open everywhere.

## Production-scale defaults (0.1.6+)

Default graph capacity is sized for real frontend repos: 25,000 JS/TS files, 100 MB compact snapshot cap, and generated-directory excludes for tracked `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.turbo`, and `storybook-static` outputs. Query responses remain budget-clipped; the larger cap only affects local snapshot storage.

If a repo still exceeds the cap, `graph-too-large` reports actual snapshot bytes and configured `graph.max_snapshot_bytes` so the fix is mechanical:

```bash
tokenomy config set graph.max_snapshot_bytes 200000000
tokenomy graph build --path "$PWD" --exclude '**/generated/**'
```

## In-repo storage (0.1.8+)

Graph snapshot/meta/build-log/sentinels now live at `<repoRoot>/.tokenomy-graph/`. Raven artifacts at `<repoRoot>/.tokenomy-raven/`. Both are auto-added to `.gitignore` on first write. Benefits:

- Visible to the user; clean up with `rm -rf .tokenomy-graph/`.
- Survives `mv repo other-name/` — no rebuild needed.
- Git worktrees get independent snapshots automatically.
- CI cache-by-path captures graph state.

**Auto-migration** of legacy `~/.tokenomy/{graphs,raven}/<repoId>/` fires once per repo on the first build / `raven enable` after upgrade. Manual: `tokenomy graph migrate [--apply]` and `tokenomy raven migrate [--apply]`. Default is dry-run.

**Project registry** at `~/.tokenomy/projects.json` (JSONL) tracks every repo with built state. Drives `graph purge --all`, `raven clean --all`, `doctor --all-repos`, `diagnose --all-repos`.

**Escape hatch:** `tokenomy config set graph.location home` (and same for `raven`) keeps the legacy `~/.tokenomy/{graphs,raven}/<repoId>/` layout — useful on read-only checkouts or CI immutable mounts.

## Incremental updates (0.1.8+ default)

`cfg.graph.incremental: true` (the default since 0.1.8) enables delta rebuilds that re-parse only stale files + direct importers. Falls back to full rebuild if tsconfig/exclude fingerprints shift or > 40 % of files changed.

## Live freshness (0.1.3+)

Pre-0.1.3 the graph snapshot only refreshed when the agent invoked a graph MCP tool. Mid-session edits via `Edit` / `Write` / `MultiEdit` / `NotebookEdit` silently drifted it out of date.

0.1.3+ wires three layers:

1. **Dirty sentinel.** PostToolUse on those edit tools touches `<repoRoot>/.tokenomy-graph/.dirty` with the changed file path. Cost per edit: one `existsSync` + one small append (~50 B). Skipped when no graph dir exists for the repo (no graph built yet).
2. **Cheap-stale short-circuit.** `isGraphStaleCheap` returns `{ stale: true }` immediately when the sentinel exists — saves the full enumerate-and-stat repo walk on every read-side MCP query. O(repo) → O(1).
3. **Async rebuild.** When the snapshot is stale-but-cached, the read-side serves the cached snapshot AND fires the rebuild in the background (process-local lockset prevents pile-up across rapid agent calls). Caller still receives `stale: true` in the response. The build clears the sentinel on success.

Opt-out: `tokenomy config set graph.async_rebuild false` reverts to the synchronous-await behavior so a doomed rebuild surfaces immediately.

## Query-scoped staleness + rebuild worker (0.1.9+)

0.1.9 makes the freshness signal actionable.

**Scoped stale.** Read-side responses now include:

- `stale_files: string[]` — the whole-graph list of files known to have drifted (the parsed sentinel content + a TTL-cached mtime/added-file walk).
- `stale_in_scope: string[]` — the subset that intersects this query's reachable surface (focal file + transitive callers/imports as the BFS walks). Empty list with `stale: true` means "drift exists but is likely unrelated to this answer."
- `whole_graph_stale: boolean` — set when an exclude / tsconfig / `.tokenomy.json` change invalidates every query, even with empty `stale_in_scope`.
- `lag_ms: number` — how long the oldest unconsumed dirty signal has been pending (read-time wall-clock; never cached).

`stale: true` stays conservative — true whenever any drift exists — because the scoped surface is built from the OLD snapshot and a new edit can introduce edges the snapshot can't show. Use `stale_in_scope.length === 0 && !whole_graph_stale && stale: true` as the low-risk-proceed signal.

**In-process rebuild worker.** `startGraphServer` spawns an `fs.watch`+debounce loop per active repo. Edits flow Edit→PostToolUse→`.dirty`→fs.watch→debounced `buildGraph`. Reads observe lag instead of driving rebuilds. Toggles:

- `graph.rebuild_worker.enabled` (default `true`)
- `graph.rebuild_worker.debounce_ms` (default `150`)
- Auto-disabled when `graph.async_rebuild: false` (worker IS the async path).

Worker is gated to server-mode only — tests / direct API callers stay on the legacy read-driven rebuild path so fs.watch handles don't leak.

Cross-platform: hook-recorded file paths are resolved against `input.cwd` at write time and normalized to forward-slash repo-relative on read, so Windows `C:\repo\src\a.ts`, POSIX `/repo/src/a.ts`, `./src/a.ts`, and backslash separators all match the graph's node ids.

**Statusline alignment.** The badge now reads the same sentinel / meta-validity check the read path uses, so `[Tokenomy v0.1.9 · graph stale - rebuild]` and the tool response's `stale` flag never disagree.

**Telemetry.** `tokenomy report` and `tokenomy analyze` gain a `Graph freshness` block: worker state, rebuild count, last/avg duration, dirty files pending, and `stale_in_scope` hit/miss counters. The hit/miss ratio quantifies the win — "X% of drift was actually relevant to a query."

## Cross-repo isolation (0.1.3+)

The MCP server's startup cwd was previously baked into every tool call. When the agent worked across multiple repos in one Claude session, every query returned data for the registered repo regardless of the active one.

0.1.3+ adds an optional `path` arg to every tool's input schema. Pass `path: "$PWD"` (or any absolute repo root) and Tokenomy resolves the per-repo graph + Raven store from that path. Default falls back to the server's startup cwd, so single-repo workflows are unchanged.

Recommended: run `tokenomy init --graph-path "$PWD"` in EACH repo so each Claude Code project window registers its own MCP server bound to its own repo.

0.1.8+: subdir invocations of any CLI/MCP command resolve to the repo root first, so a project-root `.tokenomy.json` (with overrides like `graph.location` or `raven.location`) is honored even when you `cd src/some/deep/dir` first.
