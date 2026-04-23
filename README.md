<div align="center">

<img alt="Tokenomy" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/logo.jpg" width="200">

### Stop burning tokens on tool chatter.

A surgical hook + analysis toolkit for **Claude Code, Codex CLI, Cursor, Windsurf, Cline, and Gemini** that transparently trims bloated MCP responses, clamps oversized file reads, bounds verbose shell commands, dedupes repeat calls, compresses agent memory files, and benchmarks waste — so your agent spends tokens on *thinking*, not on parsing 40 KB of Jira JSON for the third time.

[![CI](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/.github/badges/coverage.json&cacheSeconds=300)](#contribute)
[![npm](https://img.shields.io/npm/v/tokenomy.svg?label=npm&color=cb0000&cacheSeconds=300)](https://www.npmjs.com/package/tokenomy)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#quickstart)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Phase](https://img.shields.io/badge/phase%205-beta-blue)](#roadmap)
[![Tests](https://img.shields.io/badge/tests-409%20passing-brightgreen)](#contribute)

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
| `PostToolUse` on `Bash` | Claude Code | stacktrace frame compressor | Deep Jest/Pytest/Java/Rust/Go failure traces after tests/lints fail |
| `PostToolUse` on `mcp__.*` | Claude Code | duplicate-response dedup (per session) | Repeated identical tool calls — second hit returns a pointer stub, not a 30 KB refetch |
| `PreToolUse` on `Read` | Claude Code | `updatedInput` | Unbounded reads on huge source files |
| `PreToolUse` on `Bash` | Claude Code | rewrites `tool_input.command` | Unbounded verbose shell output — `git log`, `find`, `ls -R`, `ps aux`, `docker logs`, `journalctl`, `tree` |
| `PreToolUse` on `Write` | Claude Code | `additionalContext` | Reinventing existing repo work or mature utility libraries from scratch |
| `UserPromptSubmit` (alpha.22+) | Claude Code | `additionalContext` on every user turn | Agent planning without first checking graph for existing code, blast radius, or maintained libraries |
| `SessionStart` (beta.1+, Golem) | Claude Code | `additionalContext` once per session + per-turn reinforcement | Verbose assistant replies — output tokens cost 5× input on Sonnet |
| `tokenomy-graph` MCP server | Claude Code · Codex CLI | 6 tools over stdio | Brute-force `Read` sweeps of the codebase — agent gets focused context from a pre-built graph + repo/branch/package alternatives |
| `tokenomy compress` (beta.2+) | Any repo | deterministic agent-rule file cleanup + optional local Claude rewrite | Bloated `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.windsurf/rules` loaded every session |
| `tokenomy status-line` (beta.2+) | Claude Code | `settings.json.statusLine` command | Invisible installs — shows active state, Golem mode, graph freshness, and today's savings |
| `tokenomy bench` (beta.2+) | CLI | deterministic scenario runner | Reproducible savings tables for README/release notes |
| `tokenomy analyze` | Claude Code · Codex CLI transcripts | Walks `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/*.jsonl`, replays Tokenomy rules with a real tokenizer | Tells you *exactly* how much you've been wasting, by tool, by day, by rule |

Each live trim appends a row to `~/.tokenomy/savings.jsonl` with measured bytes-in / bytes-out, so you can prove the savings. Run `tokenomy report` for a TUI + HTML digest, or `tokenomy analyze` to benchmark real historical waste from session transcripts.

---

## ✨ Features

Tokenomy is organized around live hooks, graph retrieval, agent nudges, compression tools, and observability. Install once, and every Claude Code hook starts working across sessions; graph MCP registration also works across supported agents.

### 🔻 Live token trimming

Automatic response shrinking the moment a tool call finishes (or is about to fire). Zero config to get started.

- **MCP response trimming** — schema-aware profiles for Atlassian, Linear, Slack, Gmail, GitHub, Notion; generic redact + stacktrace collapse + byte-trim fallback for the long tail. Unknown top-level keys flow through untouched.
- **MCP dedup** — identical MCP responses within a 30-minute session window return a pointer stub instead of a full refetch.
- **Read clamp** — unbounded `Read` on a large source file gets rewritten to an explicit `limit: N` with an `additionalContext` note so the agent can offset-Read further regions on demand. Self-contained docs (`.md`, `.rst`, `.txt`, `.adoc`) below the doc-passthrough threshold skip clamping entirely.
- **Bash input-bounder** — verbose shell invocations (`git log`, `find`, `ls -R`, `ps aux`, `docker logs`, `journalctl`, `kubectl logs`, `tree`) get rewritten to `set -o pipefail; <cmd> | awk 'NR<=N'`. Exit codes preserved; exit-status-sensitive commands, streaming forms, destructive `find` actions, and user-piped compound commands all pass through.
- **Bash stacktrace compressor** *(beta.2+)* — failed test/lint output from `Bash` gets semantic frame trimming when it contains at least `mcp.shell_trace_trim.min_frames_to_trigger` frames (default 6) and still passes the normal savings gate (`gate.min_saved_bytes`, default 4000). Small traces intentionally pass through unchanged so readable failures stay readable.

### 🎯 Agent nudges *(redirect waste before it happens)*

Nudges cost nothing if the agent was going to do the right thing anyway — and save 10–50 k tokens per occurrence when it wasn't.

- **OSS-alternatives Write nudge** *(alpha.18+)* — when Claude creates a new file in a utility-ish path (`src/utils/**`, `src/lib/**`, `pkg/**`, `internal/**`, etc.) above 500 B, Tokenomy recommends `find_oss_alternatives` first. The agent checks this repo + local branches + npm / PyPI / pkg.go.dev / Maven Central before writing anything.
- **Golem** *(beta.1+)* — opt-in terse-output-mode plugin. Injects deterministic style rules at `SessionStart` and reinforces per-turn. Four modes: `lite` (drop hedging) → `full` (declarative sentences) → `ultra` (max 3 lines, single-word confirmations) → `grunt` (fragments, dropped articles/pronouns, occasional "ship it." / "nope." / "aye." — caveman-adjacent energy). Safety gates always preserve code, commands, warnings, and numerical results verbatim. Enable: `tokenomy golem enable [--mode=lite|full|ultra|grunt]`. Off by default; attacks the one token surface the other features leave alone — assistant output.
- **Prompt-classifier nudge** *(alpha.22+)* — fires once per user turn, **before** Claude plans. Classifies intent and points at the right graph tool:
  - `build | implement | add | create` → `find_oss_alternatives`
  - `refactor | rename | migrate | extract | replace` → `find_usages` + `get_impact_radius`
  - `remove | delete | drop | deprecate` → `get_impact_radius`
  - `review | audit | blast radius | what changed` → `get_review_context`

  Conservative by design: skips confirmations under 20 chars, short-circuits if the prompt already names a graph tool, and graph-dependent intents only fire when a graph snapshot exists for the repo.

### 🧠 Code-graph MCP *(surgical context retrieval)*

`tokenomy-graph` — a stdio MCP server exposing six tools that replace brute-force `Read` sweeps of the codebase. Works with both Claude Code and Codex CLI.

| Tool | What it does | Budget |
|---|---|---|
| `build_or_update_graph` | Build or refresh the local code graph for the current repo | 4 KB |
| `get_minimal_context` | Smallest useful neighborhood around a file or symbol | 8 KB |
| `get_impact_radius` | Reverse deps + suggested tests for changed files or symbols | 16 KB |
| `get_review_context` | Ranked hotspots + fanout across changed files | 4 KB |
| `find_usages` | Direct callers, references, importers of a file or symbol | 16 KB |
| `find_oss_alternatives` | Repo + branch + package-registry search with distinct-token ranking | 8 KB |

TypeScript / JavaScript AST via the TS compiler (no type checker); `tsconfig.paths` / `jsconfig.paths` resolved *(alpha.17+)* so `@/hooks/foo` and friends link to real source files on Next.js, Vite, Nuxt, monorepos. Read-side auto-refresh *(alpha.15+)* rebuilds on demand when files change between queries. Fail-open everywhere.

### 📊 Observability + retrospection

- **`~/.tokenomy/savings.jsonl`** — every trim and nudge appends a row with measured bytes-in / bytes-out and estimated tokens saved. Tail it: `tail -f ~/.tokenomy/savings.jsonl`.
- **`tokenomy report`** — TUI + HTML digest of recent trims grouped by tool, by reason, by day. Answers "am I actually saving tokens?"
- **`tokenomy analyze`** — walks `~/.claude/projects/**/*.jsonl` and `~/.codex/sessions/**/*.jsonl`, replays Tokenomy rules against real historical transcripts with a real tokenizer, surfaces patterns like *Wasted-probe incidents*. Answers "where have I been wasting tokens all along?"
- **`tokenomy compress`** — deterministic cleanup for agent instruction files. Preserves frontmatter, fenced/indented code, URLs, and command examples; `--in-place` writes a mandatory `.original.md` backup, and `restore` swaps it back.
- **`tokenomy bench`** — deterministic benchmark runner with JSON and markdown output for reproducible release/README tables.
- **`tokenomy doctor`** — health checks covering hook install, settings.json integrity, statusline registration, manifest drift, MCP registration, hook perf budget, and agent detection. Run anytime; run automatically on every `tokenomy update`.
- **`tokenomy update`** — single-command self-update: runs `npm install -g tokenomy@latest`, re-stages the hook, re-registers the graph MCP *(alpha.20+)* if one was previously configured. Config and logs preserved.

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

## <img src="https://claude.ai/apple-touch-icon.png" alt="Claude" width="22" style="vertical-align: middle;"> Zero-touch install via Claude Code

Don't want to read the Quickstart? Paste this into Claude Code and let the agent drive the install end-to-end. It'll install the package, register the graph MCP for this repo, enable Golem in `grunt` mode, and verify with `tokenomy doctor`:

```
Install tokenomy for me.

1. Run: npm install -g tokenomy
2. Run: tokenomy init --graph-path "$PWD"
   (this patches ~/.claude/settings.json, registers the tokenomy-graph
    MCP server for this repo, and builds the code graph)
3. Run: tokenomy golem enable --mode=grunt
   (enables terse assistant-reply mode — fragments over sentences,
    safety-gated for code and commands)
4. Run: tokenomy doctor
   (confirm all checks pass)
5. Tell me to fully quit Claude Code (Cmd+Q) and reopen so the new
   hooks + MCP server + SessionStart preamble load cleanly.

After I restart, tokenomy's hooks trim MCP/Bash/Read waste,
the graph MCP answers find_usages / get_impact_radius queries,
and Golem keeps your replies terse.
```

After the agent finishes and you restart Claude Code, run any prompt — you should see `[Tokenomy: …]` in the statusline and terse replies from Golem. To tune Golem down: `tokenomy golem enable --mode=full` (more natural) or `--mode=lite` (subtle). Disable entirely: `tokenomy golem disable`.

---

## ⚡ Quickstart

**Claude Code** (full integration — live hooks + graph + analyze):

```bash
npm install -g tokenomy
tokenomy init          # patches ~/.claude/settings.json (backed up first)
tokenomy doctor        # all checks passing
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

### Cross-agent graph install

`tokenomy init --graph-path "$PWD"` auto-detects graph-capable agents and
registers `tokenomy-graph` where possible. Force one target with `--agent`,
or inspect detection first:

```bash
tokenomy init --list-agents
tokenomy init --agent cursor --graph-path "$PWD"
tokenomy uninstall --agent cursor
```

| Agent | Hooks | Graph MCP | Install target |
|---|---:|---:|---|
| Claude Code | ✓ | ✓ | `~/.claude/settings.json` + `~/.claude.json` |
| Codex CLI | — | ✓ | `codex mcp add tokenomy-graph ...` |
| Cursor | — | ✓ | `~/.cursor/mcp.json` |
| Windsurf | — | ✓ | `~/.codeium/windsurf/mcp_config.json` |
| Cline | — | ✓ | `~/.cline/mcp_settings.json` |
| Gemini CLI | — | ✓ | `~/.gemini/settings.json` |

### Compress agent instruction files

```bash
tokenomy compress status
tokenomy compress CLAUDE.md --diff
tokenomy compress CLAUDE.md --in-place
tokenomy compress /path/to/CLAUDE.md --in-place --force  # explicit outside-cwd override
tokenomy compress restore CLAUDE.md
```

> **Pre-`1.0`.** Every release is `-beta.N`; breaking changes may land before `1.0.0` (see [CHANGELOG](./CHANGELOG.md)). Pin for stability: `npm install -g tokenomy@0.1.1-beta.2`. Upgrade with one command — `tokenomy update` (runs `npm install -g` + re-stages the hook + is idempotent; config + logs preserved). Check without installing: `tokenomy update --check`. Pin an exact release: `tokenomy update@0.1.1-beta.2` or `tokenomy update --version 0.1.1-beta.2`. Bleeding edge: see [Development](#development).

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
    PostToolUse (Bash)    ─► collapse deep test/lint stack traces after savings gate
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

**Bash stacktrace compressor (`PostToolUse`, beta.2+).** Detects Node, Python, Java, Rust, and Go stack frames in `Bash` output and preserves the assertion/error message, test names, diffs, summaries, first 3 frames, and last 2 frames. It only fires when the trace has at least 6 frames and the saved bytes pass the global trim gate (`gate.min_saved_bytes`, conservative default 8000 after aggression scaling; base default 4000). This means short or already-readable failures pass through unchanged.

**OSS-alternatives nudge (`PreToolUse` Write + MCP).** When Claude Code is about to create a new utility-like file (`src/utils/**`, `src/lib/**`, `pkg/**`, `internal/**`, Java `src/main/java/**`, etc.) above `nudge.write_intercept.min_size_bytes`, Tokenomy appends `additionalContext` recommending `mcp__tokenomy-graph__find_oss_alternatives` before bespoke implementation. The Write input is unchanged; Tokenomy never blocks the file write. The MCP tool searches the current repo, other local branches, npm, PyPI, pkg.go.dev, and Maven Central based on project files or explicit `ecosystems`, then returns `{query, ecosystems, repo_results, results, summary, hint}`. It is fail-open and budget-clipped like the graph tools. Privacy note: the search description/keywords go to public package registries when registry search runs; local repo/branch search stays on the machine. Disable the proactive Write nudge with `tokenomy config set nudge.write_intercept.enabled false` and avoid the MCP call for sensitive proprietary descriptions.

**Prompt-classifier nudge (`UserPromptSubmit`, alpha.22+).** Fires once per user turn, BEFORE Claude plans. Classifies the prompt's intent and injects `additionalContext` pointing at the right `tokenomy-graph` MCP tool: `build|implement|add|create` → `find_oss_alternatives`; `refactor|rename|migrate|extract|replace` → `find_usages` + `get_impact_radius`; `remove|delete|drop|deprecate` → `get_impact_radius`; `review|audit|blast radius|what changed` → `get_review_context`. Conservative gates: skips prompts under 20 chars, skips when the prompt already mentions a tokenomy-graph tool, graph-dependent intents only fire when a graph snapshot exists for the repo. Per-intent toggles via `nudge.prompt_classifier.intents.{build,change,remove,review}`. Disable entirely: `tokenomy config set nudge.prompt_classifier.enabled false`.

**Statusline badge (beta.2+).** `tokenomy init` patches `settings.json.statusLine` to run `tokenomy status-line` on every Claude Code UI tick. The command reads today's `savings.jsonl`, aggregates by tool/reason, and emits a one-liner like `[Tokenomy: 4.2k saved | GOLEM-GRUNT | graph fresh]`. Must return in < 50 ms — uses a bounded read of the log and no external I/O. Fails open: missing config or parse error → empty string → Claude Code renders nothing, no UI breakage. Pure observability; never affects tool calls.

**Benchmark harness (`tokenomy bench`, beta.2+).** Deterministic scenario runner — no live network, all inputs are captured fixtures committed to `fixtures/bench/`. Six scenarios exercise the full rule set (`read-clamp-large-file`, `bash-verbose-git-log`, `mcp-atlassian-search`, `shell-trace-trim`, `compress-agent-memory`, `golem-output-mode`). Each scenario runs the real rule code against its fixture, measures `bytes_in / bytes_out / tokens_saved / wall_ms` with a real tokenizer, and emits JSON or markdown. `tokenomy bench compare <a.json> <b.json>` surfaces per-scenario regressions across runs — used in CI and for reproducible README tables. Saves ~145 k tokens (~$0.44) on the current fixture set, documented in `docs/bench/RUN.md`.

**Cross-agent install (`tokenomy init --agent=<name>`, beta.2+).** Per-agent adapter files under `src/cli/agents/`. Detection is non-destructive — each adapter returns `{detected, detail, install()}` based on CLI-binary presence + config-dir presence. `tokenomy init` auto-runs every detected adapter; `--agent=<name>` forces a single target; `--list-agents` prints the detection table. Every write is atomic (temp file + rename) with a `.tokenomy-bak-<ts>` backup next to the target. Symmetric uninstall via `tokenomy uninstall --agent=<name>`. Supported: `claude-code` (hooks + MCP), `codex` (MCP via `codex mcp add`), `cursor` (`~/.cursor/mcp.json`), `windsurf` (`~/.codeium/windsurf/mcp_config.json`), `cline` (`~/.cline/mcp_settings.json`), `gemini` (`~/.gemini/settings.json`).

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
✓ Statusline registered — tokenomy status-line
✓ Agent detection — claude-code, codex, cursor
✓ Graph MCP SDK available
✓ Hook perf budget — p50=5ms p95=12ms max=14ms (n=30, budget 50ms)

16/16 checks passed
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

## 🔄 Update

```bash
tokenomy update            # install latest + re-stage hook in one shot
tokenomy update --check    # query registry, print installed vs remote, exit 1 if out of date
tokenomy update@0.1.1-beta.2   # npm-style pin
tokenomy update --version=0.1.1-beta.2  # same, explicit flag
tokenomy update --tag=beta # opt into a non-default dist-tag
```

Wraps `npm install -g tokenomy@<target>` **and** re-runs `tokenomy init` — the staged hook under `~/.tokenomy/bin/dist/` is a frozen copy taken at init time, so a plain npm upgrade leaves the hook running old code. `tokenomy update` does both in one call.

Safety:
- Refuses to install over a `npm link`-style dev checkout (your local source would be replaced by the published package). Override with `--force`.
- Refuses downgrades when the resolved version is older than what you have installed — catches cases where a pre-release dist-tag lags `latest`. Override with `--force` (warns loudly before proceeding).

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
- [x] **Phase 5.** Polish — Golem output mode, statusline with live savings counter, `UserPromptSubmit` prompt-classifier, `tokenomy compress`, deterministic `tokenomy bench`, and cross-agent graph MCP installers.
- [ ] **Phase 6.** Language breadth — Python parser plugin for the graph, richer benchmark fixtures, and npm publish at 1.0.

---

## 🤝 Contribute

Contributions welcome. Dependency-light (zero runtime deps in the hot hook path; `@modelcontextprotocol/sdk` loaded dynamically for the graph server; `js-tiktoken` optional peer for accurate `analyze`), test-first (409/409 currently green).

**Good first issues:**

| Level | What | Where |
|---|---|---|
| 🟢 | Fixture + rule-level test for an MCP tool you use (Asana, HubSpot, …) | `tests/fixtures/` + `tests/unit/mcp-content.test.ts` |
| 🟢 | More `analyze` parser support (other Codex shapes, OpenCode, Aider) | `src/analyze/parse.ts` |
| 🟡 | Built-in trim profile for another MCP server | `src/rules/profiles.ts` |
| 🟡 | More benchmark scenarios / captured fixtures | `src/bench/` + `docs/bench/` |
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
  cli/      — init, doctor (+ --fix), uninstall, config-cmd, report, analyze, graph,
              compress, bench, statusline, entry
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
npm test             # 409 tests
npm run coverage     # c8 → coverage/lcov.info + HTML
npm run typecheck    # tsc --noEmit
npm link             # point `tokenomy` at your local build
tokenomy doctor      # all checks passing
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
