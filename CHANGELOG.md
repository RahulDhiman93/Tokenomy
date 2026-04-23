<div align="center">

<img alt="Tokenomy" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/logo.jpg" width="160">

</div>

# Changelog

All notable changes to **Tokenomy** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting at `1.0.0`. Pre-`1.0.0` releases are beta and may break before the stable line.

## [Unreleased]

## [0.1.1-beta.4] — 2026-04-23

### Added

- **Raven bridge.** New Claude-first `tokenomy raven` workflow for users who
  also have Codex CLI: `enable`, `disable`, `status`, `brief`, `compare`,
  `pr-check`, `clean`, and explicit `install-commands`. `enable` gates on
  `codex` being present on `PATH` by default (`cfg.raven.requires_codex`);
  every downstream check verifies `packet.head_sha` against the current
  HEAD and refuses stale packets.
- **Raven MCP tools on `tokenomy-graph`.** Added
  `create_handoff_packet`, `read_handoff_packet`, `record_agent_review`,
  `list_agent_reviews`, `compare_agent_reviews`, `get_pr_readiness`, and
  `record_decision` for compact handoff packets, review persistence,
  deterministic comparison (bigram-Dice ≥ 0.85 on finding titles, exact on
  file/line/severity), PR readiness checks, and human decisions. All
  outputs are budget-clipped per tool.
- **Raven Claude Code nudges.** When Raven is enabled, SessionStart and
  review/handoff/readiness prompts remind Claude to use Raven packets
  instead of broad transcript reads.

### Changed

- `graph-serve` returns `0` on success instead of hanging on an unresolved
  `Promise<number>`.

### Out of scope (deferred)

- `review --agent` auto-subprocessing (use human-in-the-loop: run Codex in
  a second terminal, let it call `record_agent_review`).
- `dispatch --worktree`.

### Tests

- New: `raven-compare`, `raven-pr-check`, `raven-nudge`, `raven-cli`.
- Total: 471/471 passing.

## [0.1.1-beta.3] — 2026-04-22

### Added

- **Statusline version.** `tokenomy statusline` now prefixes the bracket
  with `v<VERSION>` (e.g. `[Tokenomy v0.1.1-beta.3 · GOLEM-GRUNT · 15.0k
  saved]`), and uses a consistent middle-dot separator across all sections.
- **Per-tool p95 latency in `report`.** `tokenomy analyze` + `tokenomy
  report` now surface p50/p95 wall-clock latency per tool (from paired
  `tool_use`/`tool_result` timestamps). New `p50ms` / `p95ms` columns in
  the `by_tool` table correlate "slow tool" with "bloated tool".
- **`tokenomy diff` CLI.** Replay one historical tool call through the
  live rule stack and print a per-rule savings breakdown plus a preview
  of the raw response. Selectors: `--call-key`, `--tool` (optional
  `--grep`), or `--session` + `--index`.
- **`tokenomy learn`.** Mines `~/.tokenomy/savings.jsonl` for recurring
  patterns and proposes a config diff (custom verbose bash entries,
  raising Read injected limit, enabling pre-call redact). Read-only by
  default; `--apply` writes the patch with a timestamped backup.
- **Pre-call redact.** Extends secret redaction to PreToolUse on
  `Bash` / `Write` / `Edit`. Bash header/URL secrets are redacted AND
  warned; bare positional args are warn-only to preserve user intent.
  Opt-in via `cfg.redact.pre_tool_use: true`; defaults to false for
  first beta-3 tag.
- **Golem auto-tune.** New `mode: "auto"` reads a per-install
  `~/.tokenomy/golem-tune.json` (written by `tokenomy analyze --tune`)
  and resolves at SessionStart. Falls back to `full` if no tune file
  exists. Thresholds: <800B p95 reply → lite, <2KB → full, <5KB → ultra,
  ≥5KB → grunt.
- **Incremental graph updates.** `cfg.graph.incremental: true` enables
  delta rebuilds that re-parse only stale files + their direct importers.
  Falls back to full rebuild when tsconfig/exclude fingerprints shift or
  when >40% of files changed. Default off; opt-in for beta-3.
- **`tokenomy budget` pre-flight gate.** PreToolUse rule that estimates
  incoming tool call response size from `~/.tokenomy/analyze-cache.json`
  (emitted by every `tokenomy analyze` run) and warns via
  `additionalContext` when the call would push the session over
  `session_cap_tokens`. Advisory only — never rejects.
  `cfg.budget.enabled: false` by default.
- **`tokenomy ci` GitHub Action.** New `action.yml` at repo root + a
  `tokenomy ci format --input=<analyze.json>` CLI that produces a
  PR-ready markdown summary. Drop into any workflow that uploads Claude
  Code / Codex transcripts as artifacts.
- PreToolUse matcher extended to `Read|Bash|Write|Edit` so the new
  pre-call redact can fire on `Edit` too.

### Changed

- `cfg.golem.mode` accepts `"auto"` in addition to `lite|full|ultra|grunt`.
- `tokenomy analyze` now writes `~/.tokenomy/analyze-cache.json` as a
  side effect (disable with `--no-cache`). Used by the budget rule.
- `SimEvent` carries an optional `latency_ms` threaded from the parser.
- `Aggregator.byTool` retains a bounded (last-200) rolling latency
  sample buffer per tool.
- `doctor` PreToolUse-coverage check now verifies `Edit` too.

### Tests

- New suites: redact-pre, budget, miner, golem-tune, diff-replay,
  ci-format.
- Updated: analyze-report (latency + cap tests), analyze-render stub,
  init-uninstall (matcher regex includes Write + Edit),
  statusline-render.

## [Unreleased-pre-beta.3]

### Added

- Codex CLI hook foothold: `tokenomy init --graph-path` now installs
  user-scoped `~/.codex/hooks.json` entries for `SessionStart` and
  `UserPromptSubmit`, and enables `features.codex_hooks` in
  `~/.codex/config.toml`. This brings Golem and prompt-classifier nudges
  to Codex sessions while leaving unsupported MCP/Bash output mutation
  out of the Codex path.
- `docs/NEXT_FEATURES.md` with a prioritized roadmap for making Tokenomy
  the agent efficiency layer for Claude Code and Codex CLI.

## [0.1.1-beta.2] — 2026-04-23

### Added

- `tokenomy compress` for deterministic agent-instruction file cleanup,
  with `status`, `restore`, `--dry-run`, `--diff`, `--in-place`, and
  optional local Claude CLI rewriting via `--llm`.
- `tokenomy status-line` plus Claude Code `settings.json.statusLine`
  registration from `tokenomy init`.
- Bash PostToolUse stacktrace compression for noisy test failures while
  preserving assertion messages, diffs, test names, and summaries.
- `tokenomy bench` deterministic benchmark harness with markdown output.
- Cross-agent graph MCP registration for Codex, Cursor, Windsurf, Cline,
  and Gemini via `tokenomy init --agent ...` and auto-detected installs
  when `--graph-path` is provided.

### Changed

- `tokenomy init --list-agents` reports local agent detection.
- `tokenomy uninstall --agent <name>` removes non-Claude graph MCP
  registrations where Tokenomy manages the config file.

### Tests

- Full suite: **409/409 passing**.

## [0.1.1-beta.1] — 2026-04-23

First beta release. The alpha.0–alpha.22 arc shipped deterministic
byte-trimming (MCP / Read / Bash), the tokenomy-graph MCP server (6
tools), repo/branch/package search, and the UserPromptSubmit prompt-
classifier nudge. Beta.1 crosses the final gap: assistant **output**
tokens, via a new opt-in plugin called Golem.

### Added

- **Golem** — a terse-output-mode plugin for the assistant's own replies.
  Injects deterministic style rules via a new `SessionStart` hook and
  reinforces per-turn via the existing `UserPromptSubmit` path so other
  plugins can't drift the rules away over long sessions. Four modes:
  - `lite`: drop hedging, pleasantries, and repeat caveats.
  - `full`: + declarative sentences only, no narration of upcoming steps,
    one-sentence conclusions (Hemingway-adjacent).
  - `ultra`: + max 3 non-code lines per reply, single-word confirmations
    where accurate.
  - `grunt`: + drop articles (a/an/the) and subject pronouns, fragments
    over sentences, occasional playful terseness ("ship it.", "nope.",
    "aye."). Tightest mode — caveman-adjacent energy, zero emoji, still
    safety-gated. A Golem that literally grunts.
  Safety gates are on by default and preserve fenced code, shell
  commands, security/auth warnings, destructive-action language, error
  messages, URLs/paths, and numerical results verbatim — in ALL modes,
  grunt included.
- **`tokenomy golem` CLI** — `enable [--mode=lite|full|ultra|grunt]`,
  `disable`, `status`. The `status` command prints the exact text that
  gets injected at SessionStart and per-turn, so users can see what Golem
  is doing with zero surprise.
- **New `SessionStart` hook registration** in `tokenomy init`. Fires
  once per Claude Code session. Passthrough (nothing injected) when
  Golem is disabled. Powers the Golem preamble when enabled.
- **Golem savings tracking.** Every SessionStart injection logs a
  `golem:session-start:<mode>` row; every per-turn reminder logs
  `golem:<mode>` with a conservative token estimate (lite 150, full 300,
  ultra 500 per turn). `tokenomy report` aggregates these alongside
  the existing trim categories.

### Changed

- `tokenomy init` now also registers the `SessionStart` hook. Existing
  installs pick this up on next `tokenomy update`.
- `tokenomy doctor` hook-entries check now verifies all four events
  (`PostToolUse`, `PreToolUse`, `UserPromptSubmit`, `SessionStart`).
- `settings-patch.HookEvent` extends to include `"SessionStart"`.
- Version channel graduates from `-alpha.*` to `-beta.*`. Config-file
  schema is considered stable for the beta line; features are additive
  and won't break existing configs.

### Tests

- +23 tests: 12 Golem unit (mode rules including grunt, safety gates,
  savings estimate monotonicity, session-context / turn-reminder
  generation) + 4 hook-spawn integration (SessionStart with/without
  Golem, UserPromptSubmit reinforcement with and without a classifier
  intent) + 7 CLI integration (enable/disable/status round-trips,
  invalid-mode rejection). Full suite: **396/396 passing**.

## [0.1.0-alpha.22] — 2026-04-22

Closes the planning-phase gap in tokenomy's nudge surface: a new
`UserPromptSubmit` hook classifies every user turn and injects
`additionalContext` pointing at the right `tokenomy-graph` MCP tool BEFORE
Claude plans — not just before a Write. So "plan X, no code" prompts and
refactor/removal questions that never reach a Write finally get nudged.

### Added

- **`UserPromptSubmit` prompt-classifier nudge** (`src/rules/prompt-classifier.ts`).
  Four intents, each toggleable:
  - `build` — `build|implement|add|create|make|write` (minus git-workflow
    nouns like "branch", "commit", "PR", "tag") → nudge toward
    `find_oss_alternatives`. Works without a graph snapshot.
  - `change` — `refactor|rename|move|migrate|consolidate|extract|split|replace|
    rewrite` → nudge toward `find_usages` + `get_impact_radius`.
  - `remove` — `remove|delete|drop|deprecate|prune|rip out` → nudge toward
    `get_impact_radius` (so "unreachable code" claims get checked).
  - `review` — `review|audit|analyze|summarize|blast radius|what changed` →
    nudge toward `get_review_context`.

  Conservative gates: skips prompts under `min_prompt_chars` (default 20),
  skips when the prompt already mentions a tokenomy-graph tool, and
  graph-dependent intents (change / remove / review) skip entirely when no
  graph snapshot exists for the repo.
- **`nudge.prompt_classifier` config surface**:
  - `nudge.prompt_classifier.enabled` (master switch, default true)
  - `nudge.prompt_classifier.intents.{build,change,remove,review}` (per-intent
    toggles, all default true)
  - `nudge.prompt_classifier.min_prompt_chars` (default 20)
- **Savings-log integration.** Every prompt-classifier nudge appends a
  `SavingsLogEntry` under `tool: "UserPromptSubmit"` with
  `reason: "nudge:prompt-classifier:{intent}"`. Conservative per-intent
  token estimates (build 15 000, change 8 000, remove 5 000, review 6 000)
  surface in `tokenomy report` alongside Read / Bash / MCP trims.

### Changed

- `tokenomy init` now also registers the `UserPromptSubmit` hook (empty
  matcher — event isn't tool-scoped). Existing installs pick this up the
  next time `tokenomy update` runs.
- `tokenomy doctor` now verifies `UserPromptSubmit` is present alongside
  `PostToolUse` / `PreToolUse`. Doctor-check count: 13 → **14**.
- `settings-patch.HookEvent` extends to `"PostToolUse" | "PreToolUse" |
  "UserPromptSubmit"`.

### Tests

- +15 tests: 13 classifier unit (per-intent triggers, passthroughs, graph-gate,
  already-mentions short-circuit, git-noun false-positive guards, min-chars
  gate, per-intent toggle) + 2 hook-spawn integration (live nudge + savings-log
  entry + short-prompt passthrough). Full suite: **373/373 passing**.

## [0.1.0-alpha.21] — 2026-04-22

Relevance ranking for `find_oss_alternatives` `repo_results`. Files that match
more distinct query tokens now rank above files that only hit the most common
token, so the actually-relevant code surfaces first.

### Changed

- **Repo-search ranks candidate files by distinct token hits before Stage 2.**
  Previously, a query like `useRuntimeConfig provider` on a large React
  codebase returned only `Provider`-matching files because `git grep` emits
  Stage 2 output in alphabetical/tree order and the `maxResults` cap stopped
  before the actually-relevant `useRuntimeConfig.ts` file got a turn.

  New behavior: Stage 1 runs one `git grep -l` per query token (capped at 8
  per query in `queryTokens`; typical queries have 2-4 tokens) and scores
  each candidate file by the number of distinct tokens it contains. The
  top-scoring files feed Stage 2 in ranked order. Because `git grep` doesn't
  honor pathspec argument order, Stage 2 output is re-sorted in code against
  the ranking before slicing to `maxResults`. Applied symmetrically to
  current-branch and other-branch paths.

  Cost: 2-4 extra `git grep -l` subprocess spawns per query (~50 ms each on
  a 5 000-file repo). Output volume is unchanged.

### Tests

- Added a unit test that seeds two files — one matching only the common
  token (`provider`) and one matching both tokens (`useRuntimeConfig` +
  `provider`) — and asserts the multi-token file ranks first. Full suite:
  **358/358 passing**.

## [0.1.0-alpha.20] — 2026-04-22

Fixes a silent truncation in `find_oss_alternatives` repo-search that collapsed
`repo_results` to `[]` on any real-world codebase, and teaches `tokenomy update`
to restage the graph MCP server when one is already registered.

### Fixed

- **`repo_results` was silently empty on large repos.** `src/nudge/repo-search.ts`
  spawned a one-stage `git grep -n -E "tok1|tok2"` with `maxBuffer: 64_000`. On
  chatbox-js with a query like `runtime configuration loader`, the same command
  produces ~2.7 MB of output — 43× over the buffer. `spawnSync` aborts with
  `ENOBUFS`, returns `status: null`, and the caller returns `[]`. Users never
  saw repo matches regardless of how many existed.

  Fix: two-stage search. Stage 1 runs `git grep -l` (filenames only — one short
  line per match file, bounded in practice by repo file count) with a 4 MB
  buffer. Stage 2 runs `git grep -n --max-count 3` against only the first 50
  returned files with an 8 MB buffer (generous enough to survive repos that
  commit bundled / minified assets with very long lines). Output is always
  small relative to repo size, and matches are still capped by `--max-count 3`
  per file and `maxResults` overall. Applied to both current-branch and
  other-branch paths.

### Changed

- **`tokenomy update` now restages the graph MCP server when one was already
  registered.** Previously, `update` only re-patched the PostToolUse /
  PreToolUse hooks; users with a `tokenomy-graph` entry in `~/.claude.json`
  had to remember to re-run `tokenomy init --graph-path=<repo>` manually to
  pick up schema changes. `update` now reads the existing graph path from
  `~/.claude.json`, validates that the directory still exists, and forwards
  `--graph-path=<existing path>` to the re-init. No new flag required; when
  no graph is registered, behavior is unchanged.

### Tests

- Added a unit test that writes enough matching files to overflow the old
  64 KB buffer (100 files, each containing the query tokens repeatedly), then
  asserts `repo_results` is still non-empty and well-formed. Full suite:
  **357/357 passing**.

## [0.1.0-alpha.19] — 2026-04-22

Improves npm package ranking for `find_oss_alternatives` by querying the npm
registry search endpoint directly, restoring npm's score/searchScore signals
for relevance, quality, popularity, and maintenance.

### Fixed

- **npm OSS alternative ranking** now uses
  `https://registry.npmjs.org/-/v1/search?text=<query>&size=20` before falling
  back to `npm search --json`. This avoids the flat `0.5` fallback scores from
  newer npm CLI output and lets canonical packages like `p-retry`,
  `async-retry`, `retry`, `axios`, `got`, and `node-fetch` surface by real npm
  relevance/composite scores.
- npm ranking now aggregates a bounded set of query variants with reciprocal
  rank scoring, then enriches the top candidate pool with npm's weekly download
  counts. This prevents literal text-match packages like `retry-cli` and scoped
  `http-client` utilities from crowding out broadly adopted libraries.
- Query-variant builder emits adjacent-token concatenations (`deep merge` →
  `deepmerge`, `rate limit` → `ratelimit`), so canonical single-word packages
  surface correctly instead of losing to multi-word near-synonyms.
- Intent penalty now covers big-vendor scopes (`@aws-amplify`, `@aws-cdk`,
  `@aws-sdk`, `@google-cloud`, `@azure`, `@cloudflare`, `@sap`, `@ibm`, …) at
  0.5× when the user's query does not mention the vendor. Keeps generic
  utility queries from returning vendor-SDK fragments that happen to keyword-
  match.
- Registry responses whose `score.final` is returned in raw relevance units are
  normalized back into a 0–1 overall score for stable tool output.

### Tests

- Updated npm-search fixtures to the registry `{ objects: [...] }` response
  shape and added coverage for registry-first behavior, CLI fallback, query
  variant aggregation, and raw registry score normalization. Full suite:
  **356/356 passing**.

## [0.1.0-alpha.18] — 2026-04-22

Adds an OSS-alternatives-first nudge so agents check for existing repo work and maintained packages before writing utility code from scratch. The feature has two parts: a new `find_oss_alternatives` MCP tool on `tokenomy-graph`, and a conservative `PreToolUse` `Write` nudge for new utility-like files.

### Added

- **`find_oss_alternatives` MCP tool** on the existing `tokenomy-graph` server. It searches the current repo, other local branches, npm, PyPI, pkg.go.dev, and Maven Central based on project files or explicit `ecosystems`, ranks candidates, filters junk/deprecated npm packages, and returns `{query, ecosystems, repo_results, results, summary, hint}` under the normal graph query budget. It is intentionally uncached because repo/branch matches depend on live working-tree and ref state.
- **`src/nudge/repo-search.ts`** — fail-open local search. In a git worktree, current-branch and other-branch matches go through `git grep` (no ripgrep dependency). Outside a git worktree, a pure-Node filesystem walk runs the same regex, skipping vendor/build dirs. Capped by timeout, result budget, and a max-files-scanned ceiling.
- **`src/nudge/npm-search.ts`** — fail-open subprocess wrapper for `npm search`. Missing npm, non-zero exits, timeouts, malformed JSON, and unexpected shapes all return structured `{ok:false, reason}` results instead of throwing.
- **`PreToolUse` `Write` nudge** (`src/rules/write-nudge.ts`). When Claude Code creates a new file in common utility paths (`src/utils/**`, `src/lib/**`, `src/parsers/**`, etc.) with content above 500 bytes, Tokenomy appends `additionalContext` recommending `mcp__tokenomy-graph__find_oss_alternatives` before bespoke implementation. The tool now checks local repo/branch matches before package candidates. The Write input is never blocked or mutated.
- **Nudge config surface**:
  - `nudge.enabled`
  - `nudge.oss_search.timeout_ms`
  - `nudge.oss_search.min_weekly_downloads`
  - `nudge.oss_search.max_results`
  - `nudge.oss_search.ecosystems`
  - `nudge.write_intercept.enabled`
  - `nudge.write_intercept.paths`
  - `nudge.write_intercept.min_size_bytes`
- **Graph query budget** for `find_oss_alternatives` (8 KB base, aggression-scaled).

### Changed

- `tokenomy init` now installs the `PreToolUse` matcher as `Read|Bash|Write`.
- `tokenomy doctor` now verifies that the PreToolUse matcher covers `Read`, `Bash`, and `Write`.

### Privacy

- `find_oss_alternatives` searches the local repo and local branches on the machine, and sends the provided description/keywords to public package registries (`npm`, PyPI, pkg.go.dev, Maven Central) depending on inferred or requested ecosystems. Tokenomy does not call a Tokenomy service. Disable the proactive Write nudge with `tokenomy config set nudge.write_intercept.enabled false`; avoid calling the MCP tool for sensitive proprietary feature descriptions.

### Tests

- +30 tests covering the npm-search wrapper, standard npm JSON output, repo/branch search (including a non-git-worktree filesystem fallback), Write nudge rule, PreToolUse Write dispatch, Write debug redaction, config defaults/scaling, and `dispatchGraphTool("find_oss_alternatives", ...)` with a fake npm binary. Full suite: **350/350 passing**.

## [0.1.0-alpha.17] — 2026-04-21

Retires the largest correctness gap in the graph: `tsconfig.json` / `jsconfig.json` `paths` and `baseUrl` are now resolved, so alias-based imports (`@/hooks/foo`, `~/lib/bar`, `@@/services/baz`, `@app/widgets`, etc.) link to real source files instead of silently becoming `external-module` nodes. Surfaces correct results on Next.js, Vite, Nuxt, and monorepo codebases — repos where `find_usages` / `get_impact_radius` previously returned 0 for widely-imported hooks because the graph had no idea what the alias meant.

### Added

- **`tsconfig.paths` / `jsconfig.paths` resolution** (`src/graph/tsconfig-resolver.ts`). Delegates to `ts.resolveModuleName` via the already-loaded TypeScript package — inherits the full TS resolver: `baseUrl`, wildcard `paths`, `extends` chains (including `@tsconfig/*` bases from `node_modules`), conditional exports, the works. Two-layer caching per build: `ts.createModuleResolutionCache` per tsconfig (TS's native probing cache, with case-insensitive canonicalization on macOS/Windows) plus a tokenomy-level `(tsconfig, importerDir, specifier)` result memo. Cache hit rate on real repos is > 95 %.
- **Monorepo-aware discovery.** For each file being extracted, the resolver walks up from `dirname(file)` to the repo root and picks the nearest `tsconfig.json` / `jsconfig.json`. Different packages in a monorepo automatically use their own alias tables. Memoized per directory.
- **`graph.tsconfig.enabled` config toggle** (default `true`). Set to `false` to restore pre-alpha.17 behavior — non-relative imports fall straight to `external-module`. Useful if TS module resolution is pathologically slow on an atypical repo.
- **`meta.tsconfig_fingerprint`** — sha256 over the raw content of every `tsconfig.json` / `jsconfig.json` reachable via `extends` chains (including package-provided bases resolved via Node's own `require.resolve`). Editing any of them — even a deeply-nested base — invalidates the cached graph. Content-based + sync, so the MCP read-side stale check can check it without loading TypeScript.
- **`enumerateAllFiles` + `enumerateGraphFilesFromRaw`** (`src/graph/enumerate.ts`) — extracted so one git-ls-files / walk is shared between source-file enumeration AND tsconfig discovery AND stale-check fingerprinting (no duplicate walks).

### Fixed

- **Cross-module resolution for alias-based imports.** Before: agent asking `find_usages` on a hook imported via `@/hooks/useFoo` in a Next.js repo got **zero callers**, because the graph edge pointed at `ext:@/hooks/useFoo` (an external node with no link to the source). After: the resolver rewires those edges to the real file, so `find_usages` / `get_impact_radius` / `get_review_context` all return correct results regardless of import style.

### Backwards-compat

- Legacy (alpha.16 and earlier) `meta.json` files have no `tsconfig_fingerprint`. On first post-upgrade build, `undefined !== currentFingerprint` → graph marked stale → one free rebuild. Same graceful-rollout pattern used for `exclude_fingerprint` in alpha.14.
- Repos with no `tsconfig.json` or `jsconfig.json` behave exactly as pre-alpha.17. No regressions.
- `src/graph/resolve.ts` signature unchanged — the new resolver layers inside the extractor via `resolveTarget`, not at the pure specifier-parsing layer.

### Known limitations (documented for future work)

- **TS solution-style configs** (`"references": [...]` with no `compilerOptions` of their own) — the nearest-parent heuristic picks the package-level tsconfig correctly, but root solution configs are skipped rather than treated as a project graph. Rare in practice.
- **`include`/`files` scoping within a tsconfig** — we don't filter by these patterns, so a file technically governed by a different tsconfig could resolve using the wrong one. Also rare.
- **Non-TS config-based aliases** (Webpack `resolve.alias`, Vite `alias`, Rollup aliases, Babel module-resolver) — deferred. Users with such setups typically mirror their aliases into `tsconfig.json` anyway (required for editor tooling / type-check).

### Tests

- +16 tests: 12 resolver scenarios (alias with wildcard, baseUrl-only, extends chain, monorepo nested tsconfigs, jsconfig.json, excluded alias targets → external-module, no-tsconfig-no-change, config toggle off, malformed tsconfig fail-open, fingerprint stability + extends-chain invalidation, auxiliary variants like `tsconfig.app.json` don't shadow the canonical `tsconfig.json`), 3 stale-check (tsconfig paths edit invalidates, toggling `tsconfig.enabled` invalidates, pre-alpha.17 meta rebuilds), 1 e2e (`find_usages` on a Next.js-style repo returns real callers through `@/` alias). Full suite: **320/320 passing**.

## [0.1.0-alpha.16] — 2026-04-21

Small follow-up to alpha.15 after dogfooding the new `find_usages` on chatbox-js hot symbols. Two papercuts to fix:

### Fixed

- **`tokenomy config set graph.query_budget_bytes.<tool> <N>` now takes effect on the very next query** — without needing a graph rebuild or Claude Code session restart. The MCP read-side cache was keyed on `(tool, args, meta.built_at)`; the per-tool budget wasn't part of the key, so a cached clipped response would keep returning until the next rebuild. Cache version now binds `meta.built_at` AND the per-tool budget: `${built_at}#b=${budget}` (`src/mcp/handlers.ts`). Only the tool whose budget changed gets invalidated — other tools' caches stay warm.

### Changed

- **Default `graph.query_budget_bytes` bumped for real-world repos.** The previous defaults clipped aggressively on medium-size repos (chatbox-js: `find_usages` on a hook with 37 usages truncated to 23 at the 4 KB default). New defaults:
  - `get_minimal_context`: 4 000 → **8 000** B
  - `get_impact_radius`: 6 000 → **16 000** B
  - `get_review_context`: 1 000 → **4 000** B
  - `find_usages`: 4 000 → **16 000** B
  - `build_or_update_graph`: unchanged (4 000 B — fixed-size payload).
  
  `find_usages` at 16 KB comfortably fits the `limitByCount(callSites, 100)` post-sort cap without truncation on all but the most extreme hot symbols. Users who want the pre-alpha.16 budget can set explicit values via `tokenomy config set graph.query_budget_bytes.<tool> <N>`. Aggression multipliers (conservative ×2 / balanced ×1 / aggressive ×0.5) still apply, floored at 512 B.

### Tests

- +1 test (`tests/unit/graph-auto-refresh.test.ts`): assert that raising `graph.query_budget_bytes.find_usages` at runtime (no rebuild, no session restart) invalidates the prior clipped cache entry and returns the full result. Full suite: **304/304 passing**.

## [0.1.0-alpha.15] — 2026-04-21

Follow-up pass after dogfooding the graph on `chatbox-js` (LiveX-AI's chatbot runtime, ~5 800 nodes / 16 700 edges). Surfaced three real gaps and two UX asks; this release ships fixes for all of them plus an explicit breaking-change callout on the `init` behavior.

### Breaking

- **`tokenomy init --graph-path=<dir>` now auto-builds the graph** as part of init. Previously init only registered the MCP server; users had to run `tokenomy graph build --path=<dir>` separately. Most callers want this — but CI/automation that expected a fast `init` exit now pays the build cost (typically 100 ms – a few seconds). **Opt out with `tokenomy init --graph-path=<dir> --no-build`** to restore the prior behavior. Acceptable for a pre-1.0 alpha stream; flagged here loudly.

### Added

- **`tokenomy graph query usages` CLI** (`src/cli/graph-query.ts`). The help banner advertised the subcommand since alpha.13 but no dispatcher branch was wired; calling it silently returned `invalid-input`. Now wired end-to-end, mirroring the MCP-side `find_usages`. Example:
  ```bash
  tokenomy graph query usages --path "$PWD" \
    --file src/runtime/RuntimeConfigProvider.tsx \
    --symbol useRuntimeConfig
  ```
- **Read-side auto-refresh on MCP queries.** `get_minimal_context`, `find_usages`, `get_impact_radius`, `get_review_context` now run a cheap stale check (`isGraphStaleCheap` in `src/graph/stale.ts` — meta-only load, mtime-only compare, no snapshot parse, no hashing) before every call and trigger a rebuild when needed. New config toggle `graph.auto_refresh_on_read` (default `true`) to disable per-user. Fresh-graph overhead: ~30–50 ms on a 5 k-file repo. No filesystem watcher, no daemon — the stale check is eager only when the agent actually queries.
- **New query-context option** `loadGraphContext({ skipStaleCheck, precomputedStale })` (`src/graph/query/common.ts`) so the read-side dispatch path doesn't re-enumerate after `ensureFreshGraph` already ran the check.

### Fixed

- **`find_usages` for widely-imported symbols returns real call sites.** Before: a hook like `useRuntimeConfig` with 17+ importers returned `call_sites: []` when queried with a symbol focal, because the extractor emits `calls` edges terminating at the local `imported-symbol` node in each caller file (not the definition). `find_usages` walked incoming edges at the focal symbol and saw none. Now: for symbol-focal queries, the query traverses focal's file → incoming `imports` edges → matching `imported-symbol` nodes → incoming `calls`/`references` edges, surfacing both file-level importers AND caller functions. Verified on chatbox-js: `useRuntimeConfig` now returns 37 usages (19 file-level + 18 function-level) where it previously returned zero.
- **Aliased named imports are correctly traced; default/namespace imports never false-positive.** Extractor now tracks `original_name` on imported-symbol nodes for all named imports (`import { foo }` → `original_name: "foo"`; `import { foo as bar }` → `name: "bar", original_name: "foo"`). Default imports (`import foo from "./mod"`) and namespace imports (`import * as ns from "./mod"`) deliberately omit `original_name` — the query matches strictly on `original_name`, so a default import whose local binding collides with a named export's name is NOT credited to that named export. Covers the name-collision false-positive that `import foo from "./mod"` used to hit against a real named `foo` export. Only backwards-compat note: find_usages on graphs built before alpha.15 will return no cross-module symbol matches until rebuilt (`tokenomy graph build --force`) — file-level importer results and intra-file references are unaffected.
- **Auto-refresh resilient to missing snapshots.** `isGraphStaleCheap` now treats a missing/corrupt `snapshot.json` (meta-alive case) as "missing", so `ensureFreshGraph` triggers a rebuild instead of letting downstream queries fail with `graph-not-built`.
- **Auto-refresh surfaces rebuild failures instead of serving stale data.** When the cheap stale check fires and the rebuild returns a `FailOpen` (`repo-too-large`, `timeout`, `build-in-progress`, `io-error`, etc.), `ensureFreshGraph` now propagates that failure to the read-side tool caller. Previously the failure was swallowed and the handler would serve the old snapshot with `ok: true` — giving a false-positive answer while hiding the actionable "fix your excludes / bump your cap" reason.
- **Read-side tools validate input before triggering a rebuild.** `get_minimal_context({})` (missing required `target.file`) now returns `invalid-input` directly instead of first kicking off a potentially-failing rebuild that might surface a misleading `repo-too-large` or similar reason.
- **Opt-out path (`auto_refresh_on_read: false`) no longer reports false staleness.** Previously the disabled path still consulted the cheap mtime-only check, which flagged `stale: true` for files that had been `touch`ed without content changes. Now the disabled path skips the cheap precheck entirely and lets `loadGraphContext` run its hash-verifying stale check — exactly restoring pre-alpha.15 behavior.
- **Recovery from corrupt snapshots.** If `snapshot.json` exists but is unparsable (e.g. interrupted write, disk corruption, manual edit), the read-side path now detects the failure at `loadGraphContext` time and triggers a rebuild + retry — instead of returning `graph-not-built` until the user runs `graph build` manually.
- **`find_usages` top-level calls are preserved over import placeholders.** When the importing file calls the symbol at top level (caller IS the file node), the traversal now records the `calls` edge BEFORE the file-level import placeholder so the real call isn't deduped behind the import. Fixed via a two-pass traversal: imported-symbol callers first, file-level importers second.
- **`find_usages` gates cross-module traversal on whether the focal is actually exported.** A query for a private method or non-exported local whose short name collides with an unrelated exported symbol in the same file no longer credits callers of the export to the local. Detection: focal is eligible when it's an `exported-symbol` node, has `exported: true`, or has an incoming `exports` edge from an `exp:` placeholder.

### Tests

- +28 unit/integration tests: `find_usages` cross-module traversal (unaliased, aliased, alias-collision guard, default-import collision guard, top-level-call preservation, non-exported-focal guard, fallback-to-local-name path), `isGraphStaleCheap` (6 paths: missing meta, missing snapshot, fresh, exclude-fingerprint-only change, mtime, added/removed), read-side auto-refresh (auto-rebuild on edit, respects `auto_refresh_on_read: false`, cache hit on no-change, FailOpen propagation instead of stale-serve, corrupt-snapshot recovery, input-validation-before-rebuild), CLI `graph query usages`, CLI `init --graph-path` auto-build + `--no-build` opt-out, config default for `auto_refresh_on_read`. Full suite: **303/303 passing**.

## [0.1.0-alpha.14] — 2026-04-21

`tokenomy graph build` used to hard-fail with `graph-too-large` the moment the enumerator walked into a committed minified vendor bundle — which is most real repos. This release ships a surgical, opt-out-friendly exclusion mechanism so the graph just works out of the box, plus the plumbing to make exclusions observable and cache-safe.

### Added

- **`graph.exclude` config key + `--exclude` CLI flag** for `tokenomy graph build`. Gitignore-style globs with `**` / `*` / `?` semantics, anchored to the posix-relative path:
  - Config: `tokenomy config set graph.exclude '["public/**","vendor/**"]'` (writes global `~/.tokenomy/config.json`; array-valued via the existing JSON-parse path).
  - CLI (repeatable, appended to config): `tokenomy graph build --path "$PWD" --exclude "public/**" --exclude "**/*.bundle.js"`.
  - Defaults (ship enabled): `**/*.min.{js,cjs,mjs}`, `**/*-min.{js,cjs,mjs}`, `**/*.bundle.{js,cjs,mjs}`, `**/*-bundle.{js,cjs,mjs}`. Covers both dot and dash naming conventions — the chatbox-js case that triggered this (`public/cdn/firebase/firebase-bundle.js`, `*.min.js` zendesk bundles) passes cleanly out of the box.
- **Filter runs BEFORE `hard_max_files`** (`src/graph/enumerate.ts`). Excluded files never count against the cap, so a repo with 10k vendor files + 200 real sources no longer trips `repo-too-large`.
- **`skipped_files` end-to-end visibility** — populated on fresh builds, round-tripped through `GraphMeta` so cached (no-op) rebuilds report accurately, surfaced via `tokenomy graph status` output, and written into the per-repo build log at `~/.tokenomy/graphs/<repo_id>/build.jsonl`.
- **Exclude-set stale invalidation.** `GraphMeta.exclude_fingerprint` — sha256 over the sorted/deduped effective exclude list — is written at build time and checked in `getGraphStaleStatus`. Change the exclude list → fingerprint mismatches → whole graph rebuilt on next invocation. No more silently-wrong cached graphs when config drifts.
- **Self-healing `graph-too-large` hint.** When a non-minified oversized file still trips the per-file edge cap, the error now reads `Edge cap exceeded in <file> — add it to graph.exclude or pass --exclude '<suggested-glob>'` instead of the bare error name.
- **Backwards-compat on upgrade.** Existing `meta.json` files predate `exclude_fingerprint`, so `undefined !== currentFingerprint()` naturally marks them stale — one free rebuild on the first post-upgrade `graph build`, then steady-state. No schema-version bump needed; `~/.tokenomy/graphs/` layout is unchanged.

### Fixed

- **Raw NUL byte in `src/graph/enumerate.ts`.** The pre-existing `.split("\u0000")` delimiter for `git ls-files -z` output was inadvertently serialized as a literal NUL byte in a prior rewrite, which made Git classify the file as binary and hid future textual diffs. Restored as an explicit unicode escape in the source; same runtime, diff-friendly source.

### Tests

- +15 tests: 9 matcher unit tests (`**`/`*`/`?` anchoring, root-file cases, regex metachar escaping) + 6 integration tests (config excludes, CLI repeatable flag, fingerprint stability, `hard_max_files` ordering, cached-path meta round-trip, exclude-change invalidation, pre-upgrade backwards-compat). Full suite: **275/275 passing**.

## [0.1.0-alpha.13] — 2026-04-20

### Added

- **`tokenomy update` — one-command self-update.** Wraps `npm install -g tokenomy@<target>` and re-stages the hook (`~/.tokenomy/bin/dist/`) so the refreshed code takes effect without a separate `tokenomy init`. Flags:
  - `tokenomy update` — install the `latest` dist-tag.
  - `tokenomy update@<version>` / `tokenomy update --version=<v>` — pin an exact release.
  - `tokenomy update --tag=alpha|beta|rc|latest` — choose a dist-tag.
  - `tokenomy update --check` — query the registry, print installed vs remote, exit 0 when up to date.
  - `tokenomy update --force` — override the dev-symlink guard and the downgrade guard.
  - Safety: detects `npm link`-style dev checkouts (by verifying the realpath of the CLI entry contains `node_modules/tokenomy/`) and refuses to install over them. Refuses downgrades when the target tag resolves to an older version than the one installed — `latest` may trail a stale `alpha` dist-tag.
- **README "Update" section** between *Code-graph MCP server* and *Uninstall*, with the full CLI surface + safety notes. Upgrade hint in the Quickstart note now points at `tokenomy update`.

## [0.1.0-alpha.12] — 2026-04-20

Re-publish of `0.1.0-alpha.11` with a single one-line fix: `src/core/version.ts` was a hardcoded string that lagged `package.json` on every prior release (alpha.11's CLI reported `0.1.0-alpha.10`, masking the publish). Bump is now synchronized. No other code changes versus alpha.11; follow-up should plumb the version from `package.json` at build time so this can't drift again.

### Fixed

- **`tokenomy --version` reports the real version.** Previously the CLI imported `TOKENOMY_VERSION` from `src/core/version.ts`, which is a hand-edited constant and had been left at `0.1.0-alpha.10` since that release. Bumped to match `package.json`.

## [0.1.0-alpha.11] — 2026-04-20

Dogfood-driven pass at the trim pipeline's two worst failure modes: (1) enumeration-shaped MCP responses were being head+tail-trimmed so hard that callers had to probe items one at a time (net-negative savings); (2) clamping self-contained docs like source files. Five targeted fixes — surgical profiles for the specific Jira cases, a shape-heuristic fallback so new tools don't re-hit the same bug, a report-level signal that flags when this goes wrong, a caller opt-out primitive, and a Read-clamp exception for markdown.

### Added

- **Four Jira enumeration profiles** (`src/rules/profiles.ts`): `atlassian-jira-transitions`, `atlassian-jira-issue-types`, `atlassian-jira-projects`, `atlassian-confluence-spaces`. Row-keep style — `max_array_items` generous (50–100), `max_string_bytes` tight (120–200). Fixes the specific case where `getTransitionsForJiraIssue` was being trimmed to ~330 B and the agent had to probe transition IDs one-by-one to rediscover the list.
- **Shape-heuristic fallback** (`src/rules/shape-trim.ts`, new). Stage 2.5 between profile match and byte-trim. When no profile applies and the response is over budget, detects homogeneous record arrays (top-level or wrapped in `{transitions|issues|values|results|data|entries|records: [...]}`) and compacts per-row (string trim + depth-limited nesting) instead of head+tail-slicing the JSON. Keeps row count intact so enumerations survive. Config: `cfg.mcp.shape_trim` (enabled/max_items/max_string_bytes).
- **Wasted-probe detector in `tokenomy analyze`** (`src/analyze/report.ts`, `src/analyze/render.ts`). New `AggregateReport.wasted_probes[]` — 60s sliding-window session-scoped detector for ≥3 distinct-arg calls to the same tool. Rendered as a `⚠ Wasted-probe incidents` section. Surfaces the over-trim failure mode that the existing savings-first `by_tool` ranking hides.
- **Caller-intent plumbing through the MCP pipeline.** `mcpContentRule` now actually uses `tool_input`. Two new primitives: `{_tokenomy: "full", ...args}` in tool input is a first-class opt-out (skip every stage, return passthrough); optional `TrimProfile.skip_when?: (input) => boolean` lets built-in or user profiles gate themselves on caller intent.
- **Read clamp: markdown/doc passthrough** (`src/rules/read-bound.ts`). New `ReadRuleConfig.doc_passthrough_extensions` (default: `.md/.mdx/.rst/.txt/.adoc`) and `doc_passthrough_max_bytes` (default: 64 KB, aggression-scaled). Files matching both pass through unclamped — self-contained docs read poorly when offset-paged. Regular source files still clamp at the existing threshold.

### Tests

- +23 unit tests: 4 profile + 10 shape-trim (incl. MCP integration) + 6 wasted-probe + 4 Read-clamp doc-passthrough + 2 MCP caller opt-out. Full suite: 249/249 passing.

## [0.1.0-alpha.10] — 2026-04-20

Re-publish of `0.1.0-alpha.9` under a fresh version tag — no code changes. The alpha.9 publish never landed on npm (previous release workflow never completed successfully for that tag); this bump lets the workflow ship the same commit without the duplicate-version guard tripping.

## [0.1.0-alpha.9] — 2026-04-20

Dogfood-driven hardening release. Three real install-path bugs surfaced the moment we ran Tokenomy against its own repo; fixed alongside a Bash bounder UX improvement, cross-agent auto-registration, the first measured real-savings data, and a refreshed architecture diagram.

### Added

- **Bash bounder now strips trailing shell comments** instead of passing the command through. `git log # debug note` used to run unbounded because the `# …` would swallow the appended awk pipe; it now gets rewritten to `set -o pipefail; git log | awk 'NR<=200'` with the comment discarded. Stripping is quote-aware: `echo "foo # bar"` and `git log --format='%H # %s'` keep their `#` intact. New exported helper `stripTrailingComment()` with its own unit coverage.
- **Codex auto-registration.** `tokenomy init --graph-path` now also runs `codex mcp add tokenomy-graph -- tokenomy graph serve --path <repo>` when the Codex CLI is on PATH. Non-fatal — Claude-only installs still succeed when Codex isn't installed. `tokenomy uninstall` mirrors with `codex mcp remove`.
- **README "Real savings from one dogfood session"** — first measured real-world result (285 K tokens / ~$0.86 in a 22-minute session), drawn from `tokenomy report` running on Tokenomy's own repo.
- **Refreshed architecture diagram** covering Phase 4 Bash bounder, the multi-stage PostToolUse pipeline, and the shared `tokenomy-graph` MCP + `tokenomy analyze` surface. Matches current state.

### Fixed

- **Read clamp now handles relative file paths.** Claude Code passes the user-typed path verbatim (e.g. `"package-lock.json"`). The rule's `statSync()` ran against the hook subprocess's cwd (not the project cwd), so stat failed and the rule returned passthrough. Result: the flagship Phase 1 feature silently no-op'd for every user-friendly `Read foo.txt` invocation. Fix: `preDispatchRead` resolves relative paths against `HookInput.cwd` before calling the rule. `readBoundRule` stays pure — the resolution is a pre-dispatch concern so the rule remains trivially unit-testable in isolation.
- **MCP registration lands in the right file for Claude Code 2.1+.** Previously `tokenomy init --graph-path` wrote the `tokenomy-graph` entry into `~/.claude/settings.json.mcpServers`, but Claude Code 2.1+ reads MCP registrations from `~/.claude.json` instead. Real installs showed `✓ Graph MCP registration — tokenomy-graph configured` in `doctor` yet `claude mcp list` never saw the server. New `src/util/claude-user-config.ts` does surgical upsert/remove on `~/.claude.json` without touching Claude Code's other internal keys (onboarding state, OAuth tokens, cache timestamps, etc.). Uninstall scrubs both the new and legacy locations for backward compat.
- **Staged hook now loads as ESM.** Previously `stageHookBinary()` copied `dist/` under `~/.tokenomy/bin/` but didn't write a `package.json`. Node walked up from the staged `.js` files, found no `type:"module"` marker, fell back to CommonJS, and threw `Cannot use import statement outside a module` on the first hook invocation — so every live trim/clamp was silently failing in real installs (all unit tests pass via tsx, which doesn't hit this path). Init now drops a minimal `{"type":"module","private":true}` package.json alongside the staged dist. Doctor smoke check now exits 0.
- **`doctor` counts bumped to 13/13**: added *"PreToolUse matcher covers Read + Bash"* check so Phase 4's Bash matcher can't silently regress.

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

[Unreleased]: https://github.com/RahulDhiman93/Tokenomy/compare/v0.1.1-beta.4...HEAD
[0.1.1-beta.4]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.1-beta.4
[0.1.1-beta.3]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.1-beta.3
[0.1.1-beta.2]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.1-beta.2
[0.1.1-beta.1]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.1-beta.1
[0.1.0-alpha.22]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.22
[0.1.0-alpha.21]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.21
[0.1.0-alpha.20]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.20
[0.1.0-alpha.19]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.19
[0.1.0-alpha.18]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.18
[0.1.0-alpha.17]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.17
[0.1.0-alpha.16]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.16
[0.1.0-alpha.15]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.15
[0.1.0-alpha.14]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.14
[0.1.0-alpha.13]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.13
[0.1.0-alpha.5]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.5
[0.1.0-alpha.4]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.0
