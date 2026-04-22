<div align="center">

<img alt="Tokenomy" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/logo.jpg" width="200">

### Stop burning tokens on tool chatter.

A surgical hook + analysis toolkit for **Claude Code and Codex CLI** that transparently trims bloated MCP responses, clamps oversized file reads, bounds verbose shell commands, dedupes repeat calls, and benchmarks historical waste — so your agent spends tokens on *thinking*, not on parsing 40 KB of Jira JSON for the third time.

[![CI](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/.github/badges/coverage.json&cacheSeconds=300)](#contribute)
[![npm](https://img.shields.io/npm/v/tokenomy.svg?label=npm&color=cb0000&cacheSeconds=300)](https://www.npmjs.com/package/tokenomy)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#quickstart)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Phase](https://img.shields.io/badge/phase%204-alpha-blue)](#roadmap)
[![Tests](https://img.shields.io/badge/tests-358%20passing-brightgreen)](#contribute)

</div>

---

## 🩻 The pain

Your last long coding-agent session — Claude Code or Codex — looked something like this:

```
Assistant → get_jira_issue        ← 40 KB
Assistant → search_jira_jql       ← 85 KB
Assistant → read src/server.ts    ← 18 KB  (2000 lines)
Assistant → read src/server.ts    ← 18 KB  (same file, again)
Assistant → read src/config.ts    ← 14 KB
...
```

200 K tokens gone before the agent did any real work. **Compaction kicks in too late, and it's lossy.**

Tokenomy plugs the holes the agent hook contracts let you close — with zero proxy, no monkey-patching:

| Surface | Works with | Mechanism | What it kills |
|---|---|---|---|
| `PostToolUse` on `mcp__.*` | Claude Code | `updatedMCPToolOutput` (multi-stage: redact → stacktrace collapse → schema-aware profile → byte trim) | 10–50 KB MCP responses from Atlassian, Notion, Gmail, Asana, HubSpot, Intercom… |
| `PostToolUse` on `mcp__.*` | Claude Code | duplicate-response dedup (per session) | Repeated identical tool calls — second hit returns a pointer stub, not a 30 KB refetch |
| `PreToolUse` on `Read` | Claude Code | `updatedInput` | Unbounded reads on huge source files |
| `PreToolUse` on `Bash` | Claude Code | rewrites `tool_input.command` | Unbounded verbose shell output — `git log`, `find`, `ls -R`, `ps aux`, `docker logs`, `journalctl`, `tree` |
| `PreToolUse` on `Write` | Claude Code | `additionalContext` | Reinventing existing repo work or mature utility libraries from scratch |
| `tokenomy-graph` MCP server | Claude Code · Codex CLI | 6 tools over stdio | Brute-force `Read` sweeps of the codebase — agent gets focused context from a pre-built graph + repo/branch/package alternatives |
| `tokenomy analyze` | Claude Code · Codex CLI transcripts | Walks `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/*.jsonl`, replays Tokenomy rules with a real tokenizer | Tells you *exactly* how much you've been wasting, by tool, by day, by rule |

Each live trim appends a row to `~/.tokenomy/savings.jsonl` with measured bytes-in / bytes-out, so you can prove the savings. Run `tokenomy report` for a TUI + HTML digest, or `tokenomy analyze` to benchmark real historical waste from session transcripts.

---

## 💸 Real savings from one dogfood session

Tokenomy run on its own repo in a fresh Claude Code session (Bash verbose commands, Read on a large file, five graph MCP queries). `tokenomy report`, verbatim:

```
Window:             2026-04-20T01:32:56Z → 2026-04-20T01:55:10Z   (~22 minutes)
Total events:       14
Bytes trimmed:      1,374,113 → 260,000   (−1,114,113)
Tokens saved (est): 285,000
~USD saved:         $0.8550

Top tools by tokens saved
  Bash    11 calls   247,500 tok      (bash-bound:git-log / :find / :ls-recursive / :ps)
  Read     3 calls    37,500 tok      (read-clamp on 89 KB package-lock.json + 2 others)
```

~20 K tokens saved per event. A dev spending 4 agent-hours a day reclaims ~$10/week. Numbers come from `~/.tokenomy/savings.jsonl` — reproduce via `CONTRIBUTING.md`'s dogfood playbook.

---

## ⚡ Quickstart

**Claude Code** (full integration — live hooks + graph + analyze):

```bash
npm install -g tokenomy
tokenomy init          # patches ~/.claude/settings.json (backed up first)
tokenomy doctor        # 13/13 ✓
# restart Claude Code — then use it normally
```

**Codex CLI** (graph MCP + transcript analysis; no live hooks yet — Codex doesn't expose the PreToolUse/PostToolUse contract). `tokenomy init --graph-path` auto-registers the graph MCP server with **both** agents when each CLI is on your PATH:

```bash
npm install -g tokenomy
tokenomy init --graph-path "$PWD"    # registers tokenomy-graph in both agents AND builds the graph
tokenomy analyze                     # benchmarks ~/.claude + ~/.codex transcripts
```

Since alpha.15, `init --graph-path` builds the graph for you in a single shot; pass `--no-build` to skip (CI, monorepos with pre-built graphs).

Codex-only / manual registration: `codex mcp add tokenomy-graph -- tokenomy graph serve --path "$PWD"`.

> **Pre-`1.0`.** Every release is `-alpha.N`; breaking changes may land on minor bumps (see [CHANGELOG](./CHANGELOG.md)). Pin for stability: `npm install -g tokenomy@0.1.0-alpha.21`. Upgrade with one command — `tokenomy update` (runs `npm install -g` + re-stages the hook + is idempotent; config + logs preserved). Check without installing: `tokenomy update --check`. Pin an exact release: `tokenomy update@0.1.0-alpha.21` or `tokenomy update --version 0.1.0-alpha.21`. Bleeding edge: see [Development](#development).

Watch trims live — `tail -f ~/.tokenomy/savings.jsonl`:

```jsonl
{"ts":"...","tool":"mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql","bytes_in":28520,"bytes_out":2800,"tokens_saved_est":6430,"reason":"mcp-content-trim"}
{"ts":"...","tool":"Read","bytes_in":48920,"bytes_out":15000,"tokens_saved_est":8480,"reason":"read-clamp"}
```

Tally one-liner: `grep -oE '"tokens_saved_est":[0-9]+' ~/.tokenomy/savings.jsonl | awk -F: '{s+=$2;n++}END{printf "trims:%d tokens:%d\n",n,s}'`.

---

## 🧠 How it actually works

```
  Claude Code live hooks
    PreToolUse (Read)  ─► clamp huge files (doc-passthrough for .md/.mdx/.rst/.txt/.adoc)
    PreToolUse (Bash)  ─► rewrite `CMD` → `set -o pipefail; CMD | awk 'NR<=N'`
    PreToolUse (Write) ─► nudge toward OSS alternatives before new utility files
    PostToolUse (mcp__.*) ─► dedup → redact → stacktrace → profile → shape-trim → byte-trim
                             └─ `{_tokenomy:"full"}` in args = passthrough (caller opt-out)
    every trim → ~/.tokenomy/savings.jsonl → `tokenomy report` (TUI + HTML)

  Shared (Claude Code + Codex CLI, stdio)
    tokenomy-graph MCP  ─► 6 tools: build_or_update_graph, get_minimal_context,
                           get_impact_radius, get_review_context, find_usages,
                           find_oss_alternatives
                           (graph tools LRU-cached on `meta.built_at + budget`;
                            find_oss_alternatives uncached — live repo/branch state)
    tokenomy analyze    ─► walks ~/.claude/projects + ~/.codex/sessions,
                           replays the full pipeline with a real tokenizer,
                           surfaces Wasted-probe incidents (over-trim failure mode)
```

### Under the hood

**Multi-stage MCP pipeline (`PostToolUse`)**, stage order:

1. **Caller opt-out.** If `tool_input._tokenomy === "full"`, skip every stage and return passthrough. Note: some strict MCP servers may reject the extra key — fallback is a per-tool `tools: {"<glob>": {disable_profiles: true}}` config override.
2. **Duplicate dedup.** Same `(tool, canonicalized-args)` seen earlier in-session within `cfg.dedup.window_seconds` → body replaced by a pointer stub. Session-scoped ledger at `~/.tokenomy/dedup/<session>.jsonl`.
3. **Secret redactor.** Regex sweep for AWS/GitHub/OpenAI/Anthropic/Slack/Stripe/Google keys, JWTs, Bearer tokens, PEM blocks → `[tokenomy: redacted <kind>]`. Force-applies regardless of gate (security > tokens).
4. **Stacktrace collapser.** Node/Python/Java/Ruby — keeps header + first + last 3 frames.
5. **Schema-aware profiles.** Keep a curated key-set (title/status/assignee/body/…), trim long strings, mark overflowing arrays. Built-ins for Atlassian Jira (issue, search, transitions, issue-types, projects) + Confluence (page, spaces) + Linear + Slack + Gmail + GitHub; users can register custom profiles. Optional `skip_when?(input)` predicate lets a profile opt out based on caller intent.
6. **Shape-aware trim (fallback).** If no profile matched and the payload is still over budget, detect homogeneous row arrays (top-level or wrapped in `{transitions|issues|values|results|data|entries|records: [...]}`) and compact per-row instead of blind head+tail. Protects enumeration endpoints from losing rows.
7. **Byte-trim fallback.** If the total still exceeds `cfg.mcp.max_text_bytes`, head+tail the remaining text with `[tokenomy: elided N bytes]` + a footer hinting Claude how to refetch full detail.

Invariants: `content.length` never shrinks, `is_error` flows through, non-text blocks (images, resources) pass untouched, unknown top-level keys preserved. `reason` reports which stages fired (e.g. `redact:3+profile:atlassian-jira-issue`, `shape-trim+mcp-content-trim`).

**Read clamp (`PreToolUse`).** Explicit `limit`/`offset` → passthrough. Self-contained docs (`.md/.mdx/.rst/.txt/.adoc` under `doc_passthrough_max_bytes`) → passthrough unclamped. Otherwise stat; under threshold → passthrough; over → inject `limit: N` + an `additionalContext` note so the agent knows it can offset-Read more regions.

**Bash input-bounder (`PreToolUse`).** Detects unbounded verbose shell invocations (`git log`, `find`, `ls -R`, `ps aux`, `docker logs`, `journalctl`, `kubectl logs`, `tree`) and rewrites to `set -o pipefail; <cmd> | awk 'NR<=200'`. Awk consumes producer output (no SIGPIPE); `pipefail` preserves exit codes. Excludes exit-status-sensitive commands (`git diff --exit-code`, `npm ls`, `git status --porcelain`), streaming forms (`-f`/`--follow`/`watch`/`top`), and destructive `find` actions (`-exec`, `-delete`). User pipelines, redirections, compound commands (`;`/`&&`/`||`), subshells, heredocs all passthrough. `head_limit` validated as integer in `[20, 10_000]` before interpolation (no command injection).

**OSS-alternatives nudge (`PreToolUse` Write + MCP).** When Claude Code is about to create a new utility-like file (`src/utils/**`, `src/lib/**`, `pkg/**`, `internal/**`, Java `src/main/java/**`, etc.) above `nudge.write_intercept.min_size_bytes`, Tokenomy appends `additionalContext` recommending `mcp__tokenomy-graph__find_oss_alternatives` before bespoke implementation. The Write input is unchanged; Tokenomy never blocks the file write. The MCP tool searches the current repo, other local branches, npm, PyPI, pkg.go.dev, and Maven Central based on project files or explicit `ecosystems`, then returns `{query, ecosystems, repo_results, results, summary, hint}`. It is fail-open and budget-clipped like the graph tools. Privacy note: the search description/keywords go to public package registries when registry search runs; local repo/branch search stays on the machine. Disable the proactive Write nudge with `tokenomy config set nudge.write_intercept.enabled false` and avoid the MCP call for sensitive proprietary descriptions.

**Fail-open is non-negotiable.** Malformed stdin / parse errors / unknown shapes → exit 0 with empty stdout. 10 MB stdin cap. 2.5 s internal timeout. Exit code 2 (blocking) never used. Breaking the agent is worse than wasting tokens.

---

## 🎛️ Configure

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
    "profiles":              [],       // user-defined schema-aware trim profiles
    "disabled_profiles":     [],       // names of built-in profiles to skip
    "shape_trim": {                    // row-preserving fallback for unprofiled inventory responses
      "enabled":          true,
      "max_items":          50,
      "max_string_bytes":  200
    }
  },
  "read": {
    "enabled":                     true,
    "clamp_above_bytes":          40000,
    "injected_limit":               500,
    "doc_passthrough_extensions": [".md", ".mdx", ".rst", ".txt", ".adoc"],
    "doc_passthrough_max_bytes":  64000 // docs below this cap skip clamping
  },
  "redact": {
    "enabled":            true,
    "disabled_patterns":    []         // e.g. ["jwt"] if you carry many non-secret JWTs
  },
  "dedup": {
    "enabled":            true,
    "min_bytes":          2000,        // don't dedup tiny responses
    "window_seconds":    1800          // dedup repeats within 30 min
  },
  "nudge": {
    "enabled": true,
    "oss_search": {
      "timeout_ms":            5000,   // per-registry search timeout
      "min_weekly_downloads":  1000,   // npm popularity proxy threshold
      "max_results":              5,   // hard-capped at 10
      "ecosystems":          ["npm"]   // fallback when project files don't imply one
    },
    "write_intercept": {
      "enabled": true,
      "paths": [
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
        "src/main/java/**",
        "src/test/java/**"
      ],
      "min_size_bytes": 500
    }
  },
  "tools": {                           // per-tool overrides (glob keys, most-specific wins)
    "mcp__Atlassian__*": { "aggression": "aggressive" },
    "mcp__Linear__*":    { "disable_profiles": true }
  },
  "perf":   { "p95_budget_ms": 50, "sample_size": 100 },
  "report": { "price_per_million": 3.0 },
  "log_path":       "~/.tokenomy/savings.jsonl",
  "disabled_tools": []
}
```

Common tweaks — `tokenomy config set <key> <value>`:

```bash
tokenomy config set aggression aggressive             # trim harder
tokenomy config set read.enabled false                # leave Read alone
tokenomy config set read.clamp_above_bytes 20000      # clamp 20 KB+ files
tokenomy config set mcp.max_text_bytes 8000           # tighter MCP budget
tokenomy config set dedup.window_seconds 600          # 10-min dedup window
tokenomy config set redact.enabled false              # opt out of redaction
tokenomy config set nudge.write_intercept.enabled false # disable Write nudges
tokenomy config set nudge.oss_search.max_results 8    # return more OSS candidates
```

**Caller opt-out.** An agent that knows it needs the full response can pass `{"_tokenomy": "full", ...real_args}` in the MCP tool input — the pipeline skips every stage. Safer fallback: set `tools: {"<glob>": {"disable_profiles": true}}` for the specific tool (works even with strict MCP servers that reject unknown keys).

---

## 🩺 `tokenomy doctor`

```
✓ Node >= 20
✓ ~/.claude/settings.json parses
✓ Hook entries present (PostToolUse + PreToolUse)
✓ PreToolUse matcher covers Read + Bash + Write — Read|Bash|Write
✓ Hook binary exists + executable
✓ Smoke spawn hook (empty mcp call) — exit=0 elapsed=74ms
✓ ~/.tokenomy/config.json parses
✓ Log directory writable
✓ Manifest drift — clean
✓ No overlapping mcp__ hook
✓ Graph MCP registration — tokenomy-graph configured in ~/.claude.json
✓ Graph MCP SDK available
✓ Hook perf budget — p50=5ms p95=12ms max=14ms (n=30, budget 50ms)

13/13 checks passed
```

Every check has an actionable remediation hint on failure. For routine repair, run `tokenomy doctor --fix` — it creates the log directory, `chmod +x`'s the hook binary, and re-patches `~/.claude/settings.json` on manifest drift.

---

## 📊 `tokenomy report`

Digest of `~/.tokenomy/savings.jsonl`:

```bash
tokenomy report                          # TUI + writes ~/.tokenomy/report.html
tokenomy report --since 2026-04-01       # date filter
tokenomy report --top 20                 # more tools in the ranking
tokenomy report --json                   # machine-readable
tokenomy report --out /tmp/report.html   # custom HTML path
```

```
Window:             2026-04-16T10:00:00Z → 2026-04-17T12:30:00Z
Total events:       4   Bytes trimmed: 185,000 → 32,000   Tokens saved: 38,250   ~USD: $0.1147

Top tools by tokens saved
  mcp__Atlassian__getJiraIssue     2×   16,750 tok
  Read                             1×   15,000 tok
  mcp__Slack__slack_read_channel   1×    6,500 tok

By reason
  profile       3×   23,250 tok
  read-clamp    1×   15,000 tok
```

HTML variant adds a daily bar chart. Pricing: `tokenomy config set report.price_per_million 15` (Opus-input rate).

---

## 🔬 `tokenomy analyze`

Where `report` shows live-hook savings, `analyze` walks the raw session transcripts — Claude Code (`~/.claude/projects/**/*.jsonl`) + Codex (`~/.codex/sessions/**/*.jsonl`) — replays the full pipeline over every historical tool call with a real tokenizer, and reports what Tokenomy *would have* saved.

```bash
tokenomy analyze                          # last 30d, top 10 tools
tokenomy analyze --since 7d               # last week
tokenomy analyze --project Tokenomy       # project-dir substring filter
tokenomy analyze --session 6689da94       # one session
tokenomy analyze --tokenizer tiktoken     # accurate cl100k counts (see below)
tokenomy analyze --json                   # machine-readable
tokenomy analyze --verbose                # per-day breakdown
```

Output: rounded-box header, per-rule savings bars, top-N waste leaderboard, duplicate hotspots, **⚠ Wasted-probe incidents** (same tool, ≥3 distinct-arg calls within 60s — surfaces over-trim failure mode), largest individual results, by-day sparkline. `--no-color` to disable ANSI.

**Tokenizers.** `heuristic` (default, zero-dep, ~±10% on code/JSON); `tiktoken` (real `cl100k_base` via `js-tiktoken` — `npm i -g js-tiktoken` then `--tokenizer=tiktoken`); `auto` picks tiktoken if present.

```
╭──────────── tokenomy analyze ────────────╮
│ Window: 2026-04-17 → 2026-04-18          │
│ Tokenizer: heuristic (approximate)       │
╰──────────────────────────────────────────╯

Summary
  Files 4   Sessions 2   Tool calls 299   Duplicates 1
  Observed 89,562 tok ($0.2687)   Tokenomy would save 1,926 (2.2%)

Savings by rule
  Duplicate-response dedup   ████████████████████████   1,926 tok
  Read clamp                 ████░░░░░░░░░░░░░░░░░░░░     324 tok

Duplicate hotspots (same args)
  Read   2×   2,263 tok wasted

⚠ Wasted-probe incidents (≥3 distinct-arg calls / 60s)
  mcp__Atlassian__getTransitionsForJiraIssue   4×   10:00:00→10:00:45   2,400 tok observed
```

`analyze` is read-only. The parser handles Claude Code's `assistant.content[].tool_use` → `user.content[].tool_result` pairing and Codex's `payload.tool_call` rollout shape.

---

## 🕸️ Code-graph MCP server (agent-agnostic, Phase 3)

Once live hooks stop bleeding tokens on tool chatter, the next waste is the agent reading half a codebase to find one function. **`tokenomy-graph`** gives the agent six surgical tools over stdio — graph built once, queries return focused neighborhoods, OSS searches stay cheap, budgets hard-capped. Works with Claude Code + Codex.

```bash
npm install -g typescript              # peer-optional; required for the graph
tokenomy init --graph-path "$PWD"      # registers with Claude Code AND Codex — and builds the graph
                                       #   (writes ~/.claude.json, shells `codex mcp add` if on PATH,
                                       #    parses TS/JS → ~/.tokenomy/graphs/<id>/; pass --no-build to skip)
tokenomy doctor                        # 13/13 ✓
# fully quit + relaunch Claude Code (Cmd+Q) so it reloads MCP servers

# verify
claude mcp list | grep tokenomy
codex mcp list | grep tokenomy        # (Codex path, if used)

# manual registration (Codex-only)
codex mcp add tokenomy-graph -- tokenomy graph serve --path "$PWD"
```

**The six tools:**

| Tool | Input | Output | Budget |
|---|---|---|---|
| `build_or_update_graph` | `{force?, path?}` | build stats | 4 KB |
| `get_minimal_context` | `{target:{file,symbol?}, depth?}` | focal + ranked neighbors | 8 KB |
| `get_impact_radius` | `{changed:[{file,symbols?}], max_depth?}` | reverse deps + suggested tests | 16 KB |
| `get_review_context` | `{files:[...]}` | fanout + hotspots across changed files | 4 KB |
| `find_usages` | `{target:{file,symbol?}}` | direct callers, references, importers | 16 KB |
| `find_oss_alternatives` | `{description, keywords?, min_weekly_downloads?, max_results?, ecosystems?}` | repo/branch matches + ranked packages + summary | 8 KB |

Stale detection always-on for graph-backed queries (`{stale, stale_files}` on every query); `tokenomy graph build --force` regenerates. In-memory LRU cache is keyed on `(tool, args, meta.built_at, budget)` for graph tools. `find_oss_alternatives` is intentionally uncached because it includes live working-tree and branch search results.

**Good prompt to test it:** *"Call `build_or_update_graph` if needed, then `get_minimal_context` for `{\"target\":{\"file\":\"src/index.ts\"},\"depth\":1}`, then `get_review_context` for `{\"files\":[\"src/index.ts\",\"src/foo.ts\"]}`. Only use Read if the graph result is insufficient."*

**Dev CLI (no MCP needed):** `tokenomy graph status | query minimal|impact|review|usages | purge [--all]`. Example: `tokenomy graph query usages --path "$PWD" --file src/foo.ts --symbol doThing` returns every call site for the named symbol across modules.

**Read-side auto-refresh (alpha.15+).** When the user edits files between agent calls, the next `get_minimal_context` / `find_usages` / `get_impact_radius` / `get_review_context` query transparently triggers a rebuild before running — no explicit `build_or_update_graph` needed. Cheap stale check (~30–50 ms on 5 k files: meta-only load + mtime compare) short-circuits to a no-op when the graph is fresh. Opt out with `tokenomy config set graph.auto_refresh_on_read false` if you want the pre-alpha.15 behavior.

**Scope + limits (v1).** TypeScript + JavaScript only (`.ts/.tsx/.js/.jsx/.mjs/.cjs`, `.mts/.cts` probed). Soft cap 2 000 files, hard cap 5 000 (abort with `repo-too-large`). AST-only via TypeScript compiler API (no type checker); type-only imports + JSX element references skipped. `tsconfig.paths` / `jsconfig.paths` **are resolved** (alpha.17+) — see below. No `node_modules` resolution — bare specifiers like `react` become `external-module` nodes. Fail-open: every tool returns `{ok: false, reason}` rather than throwing.

**Path-alias resolution (alpha.17+).** Imports like `@/hooks/useFoo`, `~/lib/bar`, `@@/services/baz`, or any other alias declared in `tsconfig.json`/`jsconfig.json` are resolved to the real source file via `ts.resolveModuleName`. Works on:

- Single-package repos (Next.js, Vite, plain TS with a root `tsconfig.json`).
- Monorepos with per-package tsconfigs — each file uses its nearest ancestor config (e.g. `packages/app-a/tsconfig.json`).
- `extends` chains, including `@tsconfig/*` bases from `node_modules`.
- `baseUrl` without `paths`.

Disable with `tokenomy config set graph.tsconfig.enabled false` (restores pre-alpha.17 behavior — useful if TS resolution is pathologically slow on your repo). Known limits: TS solution-style configs (`"references": [...]` with no `compilerOptions`) and `include`/`files` scoping within a tsconfig aren't modeled — extremely rare in practice. Editing any `tsconfig.json`, `jsconfig.json`, or base config invalidates the cached graph via a content-based fingerprint on `meta.tsconfig_fingerprint`.

**Excluding vendor bundles / minified artifacts.** Committed bundles (e.g. a 24k-line `public/cdn/firebase/firebase-bundle.js`) blow past the per-file edge cap and also pollute queries with minified identifiers. Tokenomy ships with safe defaults for common generated names — `**/*.min.{js,cjs,mjs}`, `**/*-min.{js,cjs,mjs}`, `**/*.bundle.{js,cjs,mjs}`, `**/*-bundle.{js,cjs,mjs}` — and you can layer more:

```bash
# Repeatable CLI flag (one-shot, appended to config defaults)
tokenomy graph build --path "$PWD" --exclude "public/**" --exclude "vendor/**"

# Persistent config (writes ~/.tokenomy/config.json; array value)
tokenomy config set graph.exclude '["public/**","vendor/**","**/*.bundle.js"]'
```

Globs are gitignore-style: `**` crosses directory boundaries, `*` stays within a segment, patterns anchor to the full posix path. Changing the exclude set invalidates any cached graph (fingerprinted on `meta`), so the next build is a clean rebuild — no stale node/edge sludge. Excluded files are reported in `tokenomy graph status` output and in the build log at `~/.tokenomy/graphs/<repo_id>/build.jsonl`.

---

## 🔄 Update

```bash
tokenomy update            # install latest + re-stage hook in one shot
tokenomy update --check    # query registry, print installed vs remote, exit 1 if out of date
tokenomy update@0.1.0-alpha.21   # npm-style pin
tokenomy update --version=0.1.0-alpha.21  # same, explicit flag
tokenomy update --tag=beta # opt into a non-default dist-tag
```

Wraps `npm install -g tokenomy@<target>` **and** re-runs `tokenomy init` — the staged hook under `~/.tokenomy/bin/dist/` is a frozen copy taken at init time, so a plain npm upgrade leaves the hook running old code. `tokenomy update` does both in one call.

Safety:
- Refuses to install over a `npm link`-style dev checkout (your local source would be replaced by the published package). Override with `--force`.
- Refuses downgrades when the resolved version is older than what you have installed — catches cases where the `alpha` dist-tag lags `latest`. Override with `--force` (warns loudly before proceeding).

Use `--check` in CI or a daily cron to get a non-blocking "update available" signal without touching the install.

---

## 🛑 Uninstall

```bash
tokenomy uninstall --purge
```

Removes both hook entries from `~/.claude/settings.json` (matched by absolute command path — no brittle markers), deletes `~/.tokenomy/`, and your original `settings.json` remains backed up at `~/.claude/settings.json.tokenomy-bak-<timestamp>`.

---

## 🧭 Roadmap

- [x] **Phase 1.** `PostToolUse` MCP trim + `PreToolUse` Read clamp + CLI + 12-check doctor + savings log (Claude Code).
- [x] **Phase 2.** `tokenomy analyze` — walks Claude Code + Codex CLI transcripts, replays rules with a real tokenizer, surfaces waste patterns in a fancy CLI dashboard.
- [x] **Phase 3.** Local code-graph MCP server: `tokenomy-graph` stdio server + `graph build|status|serve|query|purge` CLI + doctor check. Works with both Claude Code and Codex CLI. TypeScript AST, 5 tools, hard budget caps, fail-open everywhere.
- [x] **Phase 3.5.** Multi-stage PostToolUse pipeline: duplicate-response dedup, secret redaction, stacktrace collapse, schema-aware trim profiles (Atlassian/Linear/Slack/Gmail/GitHub), per-tool config overrides, `find_usages` graph tool, MCP query LRU cache, `tokenomy report` (TUI + HTML), hook perf telemetry, `doctor --fix`.
- [x] **Phase 4.** `PreToolUse` Bash input-bounder — rewrites verbose unbounded shell commands (`git log`, `find`, `ls -R`, `ps aux`, `docker logs`, `journalctl`, …) to cap their output via `set -o pipefail; <cmd> | awk 'NR<=N'`. Exit-status preserved, no command injection (head_limit validated), no rewrites for compound / subshell / heredoc / redirected / user-piped / streaming commands. Codex live-hook support deferred until the CLI exposes a hook contract.
- [x] **Phase 4.5.** OSS-alternatives-first nudge — `find_oss_alternatives` MCP tool with repo/branch/package search plus conservative `PreToolUse` Write context for new utility-like files.
- [ ] **Phase 5.** Polish — statusline with live savings counter, `UserPromptSubmit` prompt-classifier for effort-level nudges, Python parser plugin for the graph, npm publish at 1.0.

---

## 🤝 Contribute

Contributions welcome. Dependency-light (zero runtime deps in the hot hook path; `@modelcontextprotocol/sdk` loaded dynamically for the graph server; `js-tiktoken` optional peer for accurate `analyze`), test-first (358/358 currently green, 96% stmt / 85% branch / 100% func coverage).

**Good first issues:**

| Level | What | Where |
|---|---|---|
| 🟢 | Fixture + rule-level test for an MCP tool you use (Asana, HubSpot, …) | `tests/fixtures/` + `tests/unit/mcp-content.test.ts` |
| 🟢 | More `analyze` parser support (other Codex shapes, OpenCode, Aider) | `src/analyze/parse.ts` |
| 🟡 | Built-in trim profile for another MCP server | `src/rules/profiles.ts` |
| 🟡 | Statusline script rendering live savings from Claude Code stdin | new `src/statusline/` |
| 🔴 | Python parser plugin for the graph MCP server | new `src/parsers/py/` |

**Architecture tour:**

```
src/
  core/     — types, config (+ per-tool overrides), paths, gate, log, dedup, recovery hint
  rules/    — pure transforms: mcp-content, read-bound, bash-bound, text-trim, profiles,
              shape-trim, stacktrace, redact
  hook/     — entry + dispatch + pre-dispatch (stdin → rule → stdout)
  analyze/  — scanner (Claude Code + Codex), parse, tokens, simulate, report, render
  graph/    — schema, build, stale detection, repo-id, query/{minimal,impact,review,usages,…}
  mcp/      — stdio server, tool handlers, query-cache (LRU), budget-clip
  parsers/  — TS/JS AST extraction
  cli/      — init, doctor (+ --fix), uninstall, config-cmd, report, analyze, graph, entry
  util/     — settings-patch, manifest, atomic-write, backup, json helpers

tests/
  unit/         — one file per module, ≥1 trim + ≥1 passthrough per rule
  integration/  — spawn compiled dist/hook/entry.js or dist/cli/entry.js
  fixtures/     — synthetic graph repos + synthesized transcripts for analyze
```

Rules are pure: `(toolName, toolInput, toolResponse, config) → { kind: "passthrough" | "trim", ... }`. New rule = one-file drop-in.

**Development:**

```bash
git clone https://github.com/RahulDhiman93/Tokenomy && cd Tokenomy
npm install && npm run build
npm test             # 358 tests, ~2s
npm run coverage     # c8 → coverage/lcov.info + HTML
npm run typecheck    # tsc --noEmit
npm link             # point `tokenomy` at your local build
tokenomy doctor      # 13/13 ✓
# revert to published version: npm unlink -g tokenomy && npm install -g tokenomy
# or just:                      tokenomy update --force   (from a fresh npm-installed shell)
```

**Guiding principles.** (1) Fail-open always — broken hook worse than no hook; never exit 2. (2) Schema invariants over trust — outputs never fabricate keys, flip types, shrink arrays. (3) Path-match over markers — uninstall identifies entries by absolute command path. (4) Measure before bragging — no "X % savings" claims without Phase 2 benchmark data. (5) Small + legible — a dozen lines aren't worth a 200 KB install.

**Before opening a PR.** `npm test` green (including new unit + integration). Touched a rule → add passthrough *and* trim tests. Touched `init`/`uninstall` → extend the round-trip integration test. Added a config field → document in the Configure block above. Questions? Open a discussion — design feedback is as welcome as code.

---

## 📜 License

MIT — see [LICENSE](./LICENSE).

<div align="center">

<img alt="Tokenomy mark" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/logo.jpg" width="56">

*Save tokens. Save money. Save the rainforest — or at least your API bill.*

</div>
