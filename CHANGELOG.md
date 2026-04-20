<div align="center">

<img alt="Tokenomy" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/png/mark-primary-512-2x.png" width="160">

</div>

# Changelog

All notable changes to **Tokenomy** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting at `1.0.0`. Pre-`1.0.0` releases are alpha and may break on minor bumps.

## [Unreleased]

## [0.1.0-alpha.8] — 2026-04-19

Phase 4 lands: **`bash-bound`** — a PreToolUse rule that detects known output-focused shell invocations (`git log`, `find`, `ls -R`, `ps aux`, `docker logs`, `journalctl`, `kubectl logs`, `tree`) that the user hasn't already bounded, and rewrites the `tool_input.command` string to cap its output via `set -o pipefail; <cmd> | awk 'NR<=N'`. Awk (rather than `head`) is used to consume the producer's full output without SIGPIPE, so successful commands keep exiting 0 and failed ones propagate their real exit code through `pipefail`.

### Added

- **`src/rules/bash-bound.ts`** — new PreToolUse rule. Mirrors the `read-bound` fail-open contract. Built-in verbose patterns cover `git-log`, `git-show`, `find` (safe actions only), `ls-recursive`, `ps`, `docker-logs`, `journalctl`, `kubectl-logs`, `tree`. Respects `tool_input.run_in_background`, explicit bound flags (`-n N`, `--max-count`, `--tail`, `--depth`, `-maxdepth`, `--lines`), user-owned pipelines, redirections, compound commands (`;`, `&&`, `||`), subshells, heredocs, and streaming/interactive forms (`-f`, `--follow`, `watch`, `top`, `htop`, `less`, `more`).
- **Shell-injection hardening** — `cfg.bash.head_limit` is validated via `Number.isInteger()` and clamped to `[20, 10_000]` at rule execution time; non-integer or out-of-band values degrade to passthrough. No config value is ever interpolated into shell as-is.
- **`find -exec` ban** — `-exec`, `-execdir`, `-delete`, `-ok`, `-okdir`, `-print0`, `-fprint*` always passthrough (side-effectful or binary-output forms).
- **`src/core/types.ts`** — new `BashRuleConfig` interface; `bash: BashRuleConfig` added to `Config`.
- **`src/core/config.ts`** — `DEFAULT_CONFIG.bash` defaults (enabled, head_limit 100 unscaled → 200 under conservative aggression, custom_verbose + disabled_commands lists) and aggression-scaled `head_limit` band.
- **`src/hook/pre-dispatch.ts`** — factored into `preDispatchRead` + `preDispatchBash`; the top-level `preDispatch` delegates by tool name. Both paths use plain project config (PreToolUse does not route through `configForTool` — rationale documented in CHANGELOG-adjacent plan notes).
- **`src/cli/init.ts`** — `PRE_MATCHER` extended to `"Read|Bash"` so the installed PreToolUse entry matches both tools.
- **`src/cli/doctor.ts`** — new `PreToolUse matcher covers Read + Bash` check; remediation is `tokenomy init`.
- **`src/util/settings-patch.ts`** — new `matchersForPath()` helper used by the doctor check.
- **Analyze simulator** (`src/analyze/simulate.ts`) — new `bash_bound` per-rule credit that replays the rule against historical Bash calls and estimates savings from the real observed output newline count. Existing Read-clamp branch now also uses `projectCfg` (not `toolCfg`) to keep simulator fidelity with live PreToolUse.
- **Renderer + aggregator** — `bash_bound` rendered as *"Bash input-bounder"* and folded into the per-rule `by_rule` breakdown in `tokenomy analyze`.

### Fixed

- **`src/analyze/simulate.ts`** Read-clamp branch no longer uses `configForTool`, aligning with the live hook path (PreToolUse reads plain project config; the per-tool override cascade is PostToolUse-only).

### Tests

- New: `tests/unit/bash-bound.test.ts` (27 cases) — every passthrough branch, every binding pattern, config injection hardening, `sudo` / `time` / env-var prefix stripping, `custom_verbose` + `disabled_commands`, sibling-field preservation.
- Extended: `tests/unit/pre-dispatch.test.ts`, `tests/unit/analyze-simulate.test.ts`, `tests/unit/analyze-report.test.ts`, `tests/integration/hook-spawn.test.ts`, `tests/integration/init-uninstall.test.ts` (matcher coverage assertion).
- Total: 179 → 213 passing.

## [0.1.0-alpha.7] — 2026-04-18

Phase 2 lands: `tokenomy analyze` — walks Claude Code and Codex CLI transcripts, replays the full Tokenomy rule pipeline with a real tokenizer, and surfaces waste patterns in a fancy CLI dashboard. Also repositions the project as a toolkit for both Claude Code and Codex CLI rather than Claude-Code-only.

### Added

- **`tokenomy analyze` CLI** (`src/cli/analyze.ts` + `src/analyze/*`) — recursive JSONL scanner over `~/.claude/projects/**` and `~/.codex/sessions/**`, with filters for `--since`, `--project`, `--session`, plus `--top`, `--tokenizer`, `--json`, `--no-color`, `--verbose`.
- **Streaming scanner** (`src/analyze/scan.ts`) — `readline`-based line-by-line ingest so gigabyte transcript dirs don't OOM. Emits per-file progress to stderr so stdout stays clean for `--json` piping.
- **Transcript parser** (`src/analyze/parse.ts`) — normalizes Claude Code's `assistant → tool_use` / `user → tool_result` pairing AND Codex CLI's `payload.tool_call` rollout shape into a single `ToolCall` record. Handles both array-shape and string-shape `content` payloads.
- **Tokenizer abstraction** (`src/analyze/tokens.ts`) — default heuristic tokenizer (zero-dep, word/punct/digit-segmentation tuned for code+JSON, ~±10% of cl100k on typical tool output). Optional `--tokenizer=tiktoken` dynamically imports `js-tiktoken` for real `cl100k_base` counts (added as `peerDependenciesMeta.optional`).
- **Rule simulator** (`src/analyze/simulate.ts`) — replays dedup, redact, stacktrace-collapse, profile trim, MCP byte trim, and Read clamp over historical calls; emits per-event hypothetical savings and a canonicalized `call_key` for hotspot aggregation.
- **Aggregator** (`src/analyze/report.ts`) — folds per-event sim results into totals, by-tool top-N, by-rule breakdown, by-day series, duplicate hotspots, and outliers. USD estimate using `cfg.report.price_per_million`.
- **Fancy CLI renderer** (`src/analyze/render.ts`) — rounded-box header, progress line, per-rule bar charts, top-N waste leaderboard with inline bars, duplicate hotspots, outliers list, by-day sparkline. Pure stdlib ANSI; auto-disables color when stdout is not a TTY or `--no-color` is passed.

### Changed

- **Positioning**: Tokenomy is now framed as a toolkit for **both Claude Code and Codex CLI**. Live hooks remain Claude-Code-only for now (Codex CLI has no hook contract yet); the graph MCP server and `tokenomy analyze` work with either agent.
- **README** restructured with an agent-support matrix, separate quickstart paths for Claude Code and Codex CLI, and a new `tokenomy analyze` section documenting the fancy CLI output and tokenizer choices.
- **CONTRIBUTING** updated to reflect the new module layout (`src/analyze/`) and the agent-agnostic principle for new work.

### Added (deps)

- `js-tiktoken` declared as an **optional peer dependency**. Users who want accurate `cl100k_base` token counts in `tokenomy analyze` install it separately (`npm i -g js-tiktoken`); the core install stays lean. All other analyze features work with the built-in heuristic tokenizer.

## [0.1.0-alpha.6] — 2026-04-18

Extends the PostToolUse pipeline, graph MCP server, and CLI with 10 new features. Test suite grows from 67 → 128 passing. No new runtime dependencies.

### Added

- **Schema-aware MCP trim profiles** (`src/rules/profiles.ts`) — parses JSON tool responses and preserves essential keys instead of byte-based head+tail truncation that mangles structure. Ships with 7 built-ins: Atlassian Jira issue/search/Confluence page, Linear, Slack history, Gmail thread, GitHub PR. Users can add custom profiles via `cfg.mcp.profiles` and disable built-ins via `cfg.mcp.disabled_profiles`.
- **Stack-trace collapser** (`src/rules/stacktrace.ts`) — detects and compresses error responses in Node, Python, Java, and Ruby formats. Keeps error header + first frame + last 3 frames; elides the middle.
- **Secret redactor** (`src/rules/redact.ts`) — regex sweep for AWS access keys, GitHub PATs, OpenAI/Anthropic API keys, Slack tokens, Stripe keys, Google API keys, JWTs, Bearer tokens, and PEM private key blocks. Force-applies regardless of trim gate (security > tokens). Configurable via `cfg.redact.disabled_patterns`.
- **Duplicate-response deduplication** (`src/core/dedup.ts`) — session-scoped ledger at `~/.tokenomy/dedup/<session>.jsonl`. Repeat calls with identical `(tool, canonicalized-args)` within `cfg.dedup.window_seconds` return a pointer stub instead of re-forwarding the full response.
- **Per-tool config overrides** — `cfg.tools["mcp__Atlassian__*"] = { aggression, disable_dedup, disable_redact, disable_profiles, disable_stacktrace }`. Glob-matched, most-specific wins.
- **`find_usages` MCP graph tool** (`src/graph/query/usages.ts`) — forward lookup of direct usage sites (callers, references, importers) for a file or symbol. Complements the existing reverse `get_impact_radius`.
- **MCP query LRU cache** (`src/mcp/query-cache.ts`) — 32-entry in-memory cache keyed on `(tool, canonicalized-args, meta.built_at)`. Auto-invalidates when `build_or_update_graph` reports a fresh build.
- **`tokenomy report` CLI** (`src/cli/report.ts`) — TUI + HTML summary of `savings.jsonl`: top tools by tokens saved, by-day trend with bar chart, ~USD saved. Pricing configurable via `cfg.report.price_per_million` (default $3/M). Flags: `--since`, `--top`, `--out`, `--json`.
- **Hook perf telemetry + doctor check** — hook now records `elapsed_ms` per invocation in `~/.tokenomy/debug.jsonl`. New doctor check computes p50/p95/max over the last `cfg.perf.sample_size` runs (default 100) and flags when p95 exceeds `cfg.perf.p95_budget_ms` (default 50 ms).
- **`tokenomy doctor --fix`** — safe auto-remediation: creates missing log directory, chmods the hook binary executable, re-patches `~/.claude/settings.json` on manifest drift or missing hook entries.

### Changed

- **`mcp-content` rule** now runs a four-stage pipeline: redact → stacktrace collapse → schema-aware profile → byte-based head/tail trim (fallback). Reason strings report which stages fired (e.g. `redact:3+profile:atlassian-jira-issue+mcp-content-trim`).
- **`dispatch.ts`** force-applies trim whenever secret redaction matched, even if byte savings are below the gate threshold.
- **`GraphQueryBudgetConfig`** gains a `find_usages` byte budget (default 4 000).
- **`tokenomy graph query`** help text now lists `usages` alongside `minimal|impact|review`.

### Fixed

- OpenAI key regex now excludes the `sk-ant-` prefix so Anthropic keys are redacted with their correct pattern name.

Major release: **local code-graph MCP server** (Phase 3 of the roadmap) lands end-to-end. Tokenomy grows from a pair of transparent hooks into an opt-in context-retrieval toolkit: the agent queries a pre-built graph of your TS/JS codebase and gets focused snippets instead of brute-forcing `Read` calls.

### Added

- **Graph schema + persistent store** (`src/graph/schema.ts`, `store.ts`) — versioned JSON snapshot at `~/.tokenomy/graphs/<sha256(git-root)>/snapshot.json`. Node kinds: `file`, `external-module`, `function`, `class`, `method`, `exported-symbol`, `imported-symbol`, `test-file`. Edge kinds: `imports`, `exports`, `contains`, `calls`, `references`, `tests`. Every edge carries `confidence: "definite" | "inferred"` from day one.
- **TypeScript / JavaScript parser** (`src/parsers/ts/*`) using the TypeScript compiler API via AST-only (`ts.createSourceFile`) — no type checker, no program. Extracts imports/re-exports, named/default/namespace symbols, top-level functions/classes/methods, call edges, and `require()` / dynamic `import()` (flagged inferred). Type-only imports and JSX skipped in v1 (documented).
- **Repo identity** (`src/graph/repo-id.ts`) — `sha256(git-root)` so one cache per unique checkout, shared across Claude Code and Codex on the same machine. Falls back to `sha256(cwd)` if not in a git repo.
- **Stale detection with mtime fast-path** (`src/graph/stale.ts`) — only re-hashes files whose mtime changed. Queries always serve stale + emit `{stale, stale_files}` per the "serve stale + loud warning" policy.
- **Scale caps enforced inline** — hardcoded ignore list (`node_modules`, `.next`, `.turbo`, `.yarn`, `dist`, `coverage`, `.git`, `.nuxt`) plus a 5 000-file hard cap that trips during enumeration, not post-facto. Per-file edge cap (default 1 000) and snapshot byte cap (default 20 MB) checked pre-write.
- **Build concurrency safety** — `.build.lock` file via `openSync(path, "wx")` (`O_CREAT|O_EXCL`); concurrent builds return `{ok: false, reason: "build-in-progress"}` cleanly.
- **Pure-function queries** (`src/graph/query/{minimal,impact,review,budget,common}.ts`) — BFS over the graph with rank + pre-clip + budget-clip safety net. All three queries return `{stale, stale_files, data, truncated?}`.
- **MCP stdio server** (`src/mcp/*`) — exposes 4 tools: `build_or_update_graph`, `get_minimal_context`, `get_impact_radius`, `get_review_context`. Each tool's output is hard-capped by `budget-clip.ts` (4 KB / 4 KB / 6 KB / 1 KB respectively).
- **CLI subcommands** (`src/cli/graph{,-build,-status,-serve,-query,-purge}.ts`): `tokenomy graph build [--force] [--path]`, `graph status`, `graph serve` (spawns the MCP server), `graph query <minimal|impact|review>` (dev helper), `graph purge [--all]`.
- **Graph-aware Read-clamp hint** — `pre-dispatch.ts` now appends a nudge toward `get_minimal_context` / `get_impact_radius` / `get_review_context` when a graph snapshot exists for the current repo. Gated behind `cfg.graph.enabled` and a cheap `existsSync(~/.tokenomy/graphs/)` pre-check so the git subprocess in `resolveRepoId` is skipped on installs with no graph.
- **`tokenomy init --graph-path <dir>`** — registers the `tokenomy-graph` MCP server in `~/.claude/settings.json` alongside the existing PostToolUse / PreToolUse hooks. `tokenomy uninstall` now strips the server entry too.
- **`tokenomy doctor` gains a "Graph MCP registration" check** — reports whether the server is registered and flags path/args drift.
- **`typescript` is a `peerDependencies` + `peerDependenciesMeta.optional`** — core install stays zero-runtime-deps. Users who want the graph run `npm i -g typescript` alongside. `loader.ts` falls back with a structured error if missing.
- **Config extension** — new `DEFAULT_CONFIG.graph` section: `enabled`, `max_files`, `hard_max_files`, `build_timeout_ms`, `max_edges_per_file`, `max_snapshot_bytes`, `query_budget_bytes.{build_or_update_graph, get_minimal_context, get_impact_radius, get_review_context}`. Aggression multiplier scales all numeric budgets.
- **Graph build log** — best-effort JSONL at `~/.tokenomy/graphs/<id>/build.jsonl` via `appendGraphBuildLog`.
- **Fixture repo for tests** (`tests/fixtures/graph-fixture-repo/`) — 8-file synthetic TS/JS repo exercising imports, re-exports, default exports, require, dynamic import, and a co-located test file.
- **23 new tests** across unit (schema, repo-id, store, enumerate, stale, resolve, parser loader, parser import extraction, pre-dispatch) and integration (graph-build-cli, graph-status-cli, graph-mcp, init-uninstall graph-path path). Total: 67 passing.

### Fixed

- **Resolver silently dropped `.js` imports to `.ts` sources** (TypeScript NodeNext convention). The specifier-already-has-extension branch short-circuited the probe loop, so `import … from "./foo.js"` never tried `./foo.ts`. On Tokenomy's own source: **146 phantom parse errors → 0**. Resolver now also tries `.tsx` for `.jsx`, `.mts` for `.mjs`, `.cts` for `.cjs`. Regression tests added.
- **`tokenomy graph query … --file <path>`** with space-separated flags returned `invalid-input`. The outer CLI parser consumed `--file` / `--files` into its own flags map before forwarding to `runGraphQuery`. Fix: forward raw argv for the `query` subcommand; let the inner parser own its flags end-to-end.
- **`resolveRepoId` was called (spawning `git`) on every Read hook invocation**, even when no graph had ever been built. Fix: early-return `graphHint` if `~/.tokenomy/graphs/` directory doesn't exist.

### Notes

- `@modelcontextprotocol/sdk` is now a **runtime dependency**. This is the first non-zero-deps addition. The core hook path still has zero deps at runtime (typescript / @modelcontextprotocol/sdk are loaded dynamically only when the graph path is exercised).

## [0.1.0-alpha.4] — 2026-04-17

### Changed
- Publish workflow simplified: release-triggered publishes always use `--tag latest`. The previous approach (publish to `alpha`, then a separate `npm dist-tag add … latest` step) fails because npm's OIDC trusted publishing only covers the `publish` command, not `dist-tag` mutations. During the alpha phase, `latest` == newest is the right semantic anyway — the `-alpha.N` suffix in the version string is the only pre-release signal users need. When stable 1.0 ships, we'll revisit split tags.
- Manual `workflow_dispatch` runs still respect the user's explicit tag choice (useful for canary beta/rc publishes without moving `latest`).

## [0.1.0-alpha.3] — 2026-04-17

### Added
- `publish.yml` now auto-updates the `latest` dist-tag to the newest release after a successful publish. `npm install tokenomy` (no tag) always pulls the most recent version; the npm badge and npmjs.com landing page stay current without manual `npm dist-tag add` + OTP.

## [0.1.0-alpha.2] — 2026-04-17

### Added
- Dual-publish to GitHub Packages (`@rahuldhiman93/tokenomy`) in the `publish.yml` workflow, alongside the primary npmjs.com publish. Populates the repo's "Packages" sidebar on GitHub.

### Changed
- README prioritizes `npm install -g tokenomy@alpha` over the local clone-build-link flow. The Development section now clearly frames source installs as the bleeding-edge / contributor path, not the default.

## [0.1.0-alpha.1] — 2026-04-17

First release cut via the new `publish.yml` workflow. End-to-end verification of the OIDC trusted-publishing flow + provenance attestation.

### Added

- CONTRIBUTING.md with pick-a-task guide, local dev loop, code conventions, testing philosophy, PR workflow, bug-report and code-of-conduct sections.
- `.github/pull_request_template.md` with surface checklist, test-plan block, and invariant preservation checklist.
- `CHANGELOG.md` (this file).
- GitHub Actions CI workflow running `build`, `test`, and `c8` coverage on Node 20 + 22.
- `c8` dev dependency + `npm run coverage` script (json-summary + lcov + html reporters).
- Self-hosted coverage badge via `shields.io` dynamic endpoint backed by `.github/badges/coverage.json` — no third-party account required; CI auto-commits the JSON on main pushes.
- README badges for CI status, self-hosted coverage, and npm version.
- `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` as GitHub Issue Forms, plus `config.yml` routing architectural discussions to Discussions and security issues to email.
- `.github/workflows/publish.yml` — OIDC-based npm trusted publishing on GitHub Release (auto-infers dist-tag from pre-release suffix: `*-alpha* → alpha`, `*-beta* → beta`, `*-rc* → rc`, stable → `latest`). Manual `workflow_dispatch` supports a dry-run toggle. No npm token needed; uses `id-token: write` + `--provenance` for supply-chain attestation.
- Initial npm publish: `tokenomy@0.1.0-alpha.0` under the `@alpha` dist-tag.

## [0.1.0-alpha.0] — 2026-04-17

First public alpha. Phase 1 scope: transparent MCP tool-output trimming via `PostToolUse` + automatic `Read` input clamping via `PreToolUse`.

### Added

- **`PostToolUse` hook matcher `mcp__.*`** — trims MCP tool responses via `hookSpecificOutput.updatedMCPToolOutput`. Handles both the `CallToolResult` object shape (`{content: [...]}`) and the raw content-array shape used by Claude.ai connectors. Preserves non-text blocks in original position, head+tail trims text blocks that exceed budget, appends a single recovery-hint footer. Never shrinks `content.length`.
- **`PreToolUse` hook matcher `Read`** — when `Read` is called without explicit `limit` / `offset` and the target file exceeds `read.clamp_above_bytes`, injects `limit: read.injected_limit` and an `additionalContext` note so Claude can `offset`-Read more regions.
- **CLI** — `tokenomy init` / `doctor` / `uninstall` / `config get|set`. Idempotent install, atomic settings.json write with parent-dir fsync, timestamped backup with collision counter, path-based uninstall (no brittle marker keys).
- **`tokenomy doctor`** — 9 deterministic checks (Node ≥ 20, settings parse, both hook entries present, hook binary executable, smoke-spawn latency, config parse, log dir writable, manifest drift, overlapping `mcp__.*` warning).
- **Savings log** at `~/.tokenomy/savings.jsonl` — one JSONL row per trim with `tokens_saved_est`.
- **Debug log** at `~/.tokenomy/debug.jsonl` — one row per hook invocation (including passthroughs) for diagnosis.
- **Install manifest** at `~/.tokenomy/installed.json` — diagnostic-only; uninstall identifies hooks by command path, not manifest UUID.
- **Config** — global `~/.tokenomy/config.json` merged with per-repo `./.tokenomy.json`; aggression multiplier (`conservative` ×2 / `balanced` ×1 / `aggressive` ×0.5) scales numeric thresholds.
- **41 tests** — unit (rules, gate, config, manifest, settings-patch), integration (hook subprocess spawn, init+uninstall round-trip against tmp HOME). All pass in under one second.

### Design principles

- Fail-open always (exit 0 with empty stdout on any error; exit 2 never used).
- Schema invariants asserted by tests (no fabricated keys, no type flips, no lost `is_error`).
- Zero runtime dependencies; hook binary is Node stdlib only.
- Path-match over injected markers for uninstall stability.
- No "X% savings" claims until Phase 2 benchmarks them against a real transcript corpus.

### Out of scope (deferred to later phases)

- Trimming `Bash` / `Grep` / `Glob` output — the Claude Code hook contract restricts `updatedMCPToolOutput` to MCP tools.
- `Bash` input-bounding via `PreToolUse` — Phase 4.
- MCP companion server (`tokenomy_summarize`, etc.) portable to Codex — Phase 3.
- Statusline with live savings counter — Phase 2.
- `tokenomy analyze` over transcripts — Phase 2.

[Unreleased]: https://github.com/RahulDhiman93/Tokenomy/compare/v0.1.0-alpha.5...HEAD
[0.1.0-alpha.5]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.0
