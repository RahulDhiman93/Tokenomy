<div align="center">

<img alt="Tokenomy" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/png/mark-primary-512-2x.png" width="200">

### Stop burning tokens on tool chatter.

A surgical hook + analysis toolkit for **Claude Code and Codex CLI** that transparently trims bloated MCP responses, clamps oversized file reads, bounds verbose shell commands, dedupes repeat calls, and benchmarks historical waste — so your agent spends tokens on *thinking*, not on parsing 40 KB of Jira JSON for the third time.

[![CI](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/.github/badges/coverage.json&cacheSeconds=300)](#contribute)
[![npm](https://img.shields.io/npm/v/tokenomy.svg?label=npm&color=cb0000&cacheSeconds=300)](https://www.npmjs.com/package/tokenomy)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#quickstart)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Phase](https://img.shields.io/badge/phase%204-alpha-blue)](#roadmap)
[![Tests](https://img.shields.io/badge/tests-213%20passing-brightgreen)](#contribute)

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
| `tokenomy-graph` MCP server | Claude Code · Codex CLI | 5 tools over stdio | Brute-force `Read` sweeps of the codebase — agent gets focused context from a pre-built graph |
| `tokenomy analyze` | Claude Code · Codex CLI transcripts | Walks `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/*.jsonl`, replays Tokenomy rules with a real tokenizer | Tells you *exactly* how much you've been wasting, by tool, by day, by rule |

Each live trim appends a row to `~/.tokenomy/savings.jsonl` with measured bytes-in / bytes-out, so you can prove the savings. Run `tokenomy report` for a TUI + HTML digest, or `tokenomy analyze` to benchmark real historical waste from session transcripts.

---

## ⚡ Quickstart

### Claude Code (full integration: live hooks + graph + analyze)

```bash
npm install -g tokenomy
tokenomy init          # patches ~/.claude/settings.json (backed up first)
tokenomy doctor        # 12/12 ✓
# restart Claude Code
```

That's it. Use Claude Code normally. Tokenomy does the rest.

### Codex CLI (graph MCP server + transcript analysis)

Codex doesn't expose PostToolUse/PreToolUse hooks yet, so the live trim features are Claude-Code-only. But the two **agent-agnostic** features work great with Codex:

```bash
npm install -g tokenomy
codex mcp add tokenomy-graph -- tokenomy graph serve --path "$PWD"
tokenomy graph build --path "$PWD"
# Codex can now call build_or_update_graph / get_minimal_context / get_impact_radius
# / get_review_context / find_usages, exactly as Claude Code does.

tokenomy analyze       # benchmarks both ~/.claude and ~/.codex transcripts
```

> **Still pre-`1.0`.** Every release carries an `-alpha.N` suffix and breaking changes may land on minor bumps — the [CHANGELOG](./CHANGELOG.md) calls them out. Users who want stability should pin a specific version: `npm install -g tokenomy@0.1.0-alpha.8`.

> **Upgrading?** `npm install -g tokenomy` again — the install runs idempotently; existing config + logs are preserved.

> **Want the bleeding edge?** Scroll to [Development](#development) for the clone-build-link flow.

To watch the magic live:

```bash
tail -f ~/.tokenomy/savings.jsonl
```

Each row is one transparent trim. Sample from a real session:

```jsonl
{"ts":"...","tool":"mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql","bytes_in":28520,"bytes_out":2800,"tokens_saved_est":6430,"reason":"mcp-content-trim"}
{"ts":"...","tool":"Read","bytes_in":48920,"bytes_out":15000,"tokens_saved_est":8480,"reason":"read-clamp"}
```

One-liner to tally:

```bash
grep -oE '"tokens_saved_est":[0-9]+' ~/.tokenomy/savings.jsonl \
  | awk -F: '{s+=$2; n++} END{printf "trims: %d   tokens saved: %d\n", n, s}'
```

---

## 🧠 How it actually works

```
   ┌────────────────── Claude Code (full integration) ──────────┐
   │                                                            │
   │   user prompt → LLM → tool call                            │
   │                          │                                 │
   │   ┌──────────────────────┼─────────────────────────────┐  │
   │   │                      ▼                              │  │
   │   │   PreToolUse (Read)  ──► tokenomy-hook ──► inject   │  │
   │   │                           │                   limit │  │
   │   │                      ▼    ▼                          │  │
   │   │                   file read runs (narrower)          │  │
   │   │                      │                               │  │
   │   │   PostToolUse (mcp__.*) ──► tokenomy-hook ──► trim  │  │
   │   │                           │             content[]   │  │
   │   │                      ▼    ▼                          │  │
   │   │                   LLM sees the trimmed version       │  │
   │   └──────────────────────────────────────────────────────┘  │
   │                          │                                 │
   │              savings.jsonl  ◄──  best-effort append        │
   └────────────────────────────────────────────────────────────┘

   ┌────────────── Claude Code · Codex CLI (shared) ────────────┐
   │                                                            │
   │   tokenomy-graph MCP   → focused neighborhood queries      │
   │   tokenomy analyze     → replays rules over transcripts    │
   └────────────────────────────────────────────────────────────┘
```

### Under the hood

**Multi-stage MCP pipeline (`PostToolUse`).** For every `mcp__.*` response, Tokenomy runs four stages in order:

1. **Duplicate dedup** — if this exact `(tool, canonicalized-args)` was seen earlier in the same session and is still within `cfg.dedup.window_seconds`, the body is replaced with a short pointer stub (`[tokenomy: duplicate of call #N at <time> — no refetch required.]`). Session-scoped ledger lives under `~/.tokenomy/dedup/<session>.jsonl`.
2. **Secret redactor** — regex sweep catches AWS access keys, GitHub PATs, OpenAI/Anthropic API keys, Slack tokens, Stripe keys, Google API keys, JWTs, Bearer tokens, and PEM private key blocks. Replaced with `[tokenomy: redacted <kind>]`. Force-applies even when byte savings are below the gate threshold (security > tokens).
3. **Stacktrace collapser** — detects Node, Python, Java, Ruby error shapes and keeps error header + first frame + last 3 frames, eliding the middle.
4. **Schema-aware trim profiles** — parses JSON responses and keeps a curated set of keys (title/status/assignee/body/etc.), truncating long strings and overflowing arrays with explicit markers. Ships with built-ins for Atlassian Jira/Confluence, Linear, Slack, Gmail, and GitHub; users can register custom profiles in config.
5. **Byte-trim fallback** — if stages 1–4 together still exceed `cfg.mcp.max_text_bytes`, the remaining text block is head+tail trimmed with an explicit `[tokenomy: elided N bytes]` marker. A footer block tells Claude how to re-invoke for full detail.

`content.length` never shrinks, `is_error` flows through, non-text blocks (images, resources) pass through untouched, and unknown top-level keys are preserved. Each trim's `reason` reports which stages fired (e.g. `redact:3+profile:atlassian-jira-issue`).

**Read clamp (`PreToolUse`).** If the agent's `Read` call has an explicit `limit` or `offset`, passthrough — respect user intent. Otherwise, stat the file. Under threshold → passthrough. Over threshold → inject `limit: N` plus an `additionalContext` note so the agent knows it can offset-Read more regions.

**Bash input-bounder (`PreToolUse`).** Detects output-focused shell invocations (`git log`, `find`, `ls -R`, `ps aux`, `docker logs`, `journalctl`, `kubectl logs`, `tree`) that aren't already bounded and rewrites the command to cap its output:

```
set -o pipefail; <your command> | awk 'NR<=200'
```

Awk consumes the producer's full output (no SIGPIPE) and prints the first N lines; `set -o pipefail` preserves the producer's real exit code so `git log` failing still returns non-zero. Defaults explicitly exclude exit-status-sensitive commands (`git diff --exit-code`, `npm ls`, `git status --porcelain`), streaming forms (`-f` / `--follow` / `watch` / `top`), and destructive `find` actions (`-exec`, `-delete`). User-owned pipelines (`find . | xargs rm`), redirections (`> file`), compound commands (`;`, `&&`, `||`), subshells, and heredocs all passthrough. `head_limit` is validated as an integer in `[20, 10_000]` before shell interpolation to rule out config-driven command injection.

**Fail-open is a non-negotiable.** Malformed stdin, parse errors, unknown shapes → exit 0 with empty stdout (true passthrough). 10 MB stdin cap. 2.5 s internal timeout. Exit code 2 (blocking) is never used. Breaking the agent is worse than wasting tokens.

---

## 🎛️ Configure

`~/.tokenomy/config.json` (per-repo override: `./.tokenomy.json`).

```jsonc
{
  "aggression": "conservative",        // × 2 thresholds. balanced=× 1, aggressive=× 0.5
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
    "disabled_profiles":     []        // names of built-in profiles to skip
  },
  "read": {
    "enabled":            true,
    "clamp_above_bytes": 40000,
    "injected_limit":      500
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
  "tools": {                           // per-tool overrides (glob keys, most-specific wins)
    "mcp__Atlassian__*": { "aggression": "aggressive" },
    "mcp__Linear__*":    { "disable_profiles": true }
  },
  "perf": {
    "p95_budget_ms":       50,         // doctor flags when hook p95 exceeds this
    "sample_size":        100
  },
  "report": {
    "price_per_million":    3.0        // USD/M tokens — used for ~$ saved estimate
  },
  "log_path":       "~/.tokenomy/savings.jsonl",
  "disabled_tools": []
}
```

Common tweaks:

```bash
tokenomy config set aggression aggressive             # trim harder, save more
tokenomy config set read.enabled false                # just do MCP, leave Read alone
tokenomy config set read.clamp_above_bytes 20000      # clamp 20 KB+ files
tokenomy config set mcp.max_text_bytes 8000           # tighter MCP budget
tokenomy config set dedup.window_seconds 600          # only dedup repeats within 10 min
tokenomy config set redact.enabled false              # opt out of secret redaction
```

Config changes take effect **immediately** — no Claude Code restart needed. Only the initial `init` requires a restart.

---

## 🩺 `tokenomy doctor`

```
✓ Node >= 20
✓ ~/.claude/settings.json parses
✓ Hook entries present (PostToolUse + PreToolUse)
✓ Hook binary exists + executable
✓ Smoke spawn hook (empty mcp call) — exit=0 elapsed=111ms
✓ ~/.tokenomy/config.json parses
✓ Log directory writable
✓ Manifest drift — clean
✓ No overlapping mcp__ hook
✓ Graph MCP registration — not configured
✓ Graph MCP SDK available
✓ Hook perf budget — p50=4ms p95=11ms max=38ms (n=100, budget 50ms)

12/12 checks passed
```

Every check has an actionable remediation hint on failure. For routine repair, run `tokenomy doctor --fix` — it creates the log directory, `chmod +x`'s the hook binary, and re-patches `~/.claude/settings.json` on manifest drift.

---

## 📊 `tokenomy report`

Once the hooks have been running for a while, `savings.jsonl` is hard to eyeball. `tokenomy report` turns it into a digest:

```bash
tokenomy report                          # TUI summary + writes ~/.tokenomy/report.html
tokenomy report --since 2026-04-01       # filter by date
tokenomy report --top 20                 # more tools in the ranking
tokenomy report --json                   # machine-readable output
tokenomy report --out /tmp/report.html   # custom HTML path
```

Sample output:

```
tokenomy report
===============

Window:            2026-04-16T10:00:00Z  →  2026-04-17T12:30:00Z
Total events:      4
Bytes trimmed:     185,000 → 32,000  (−153,000)
Tokens saved (est): 38,250
~USD saved:        $0.1147

Top tools by tokens saved
  mcp__Atlassian__getJiraIssue                  2 calls        16,750 tok
  Read                                          1 calls        15,000 tok
  mcp__Slack__slack_read_channel                1 calls         6,500 tok

By reason
  profile                   3 calls        23,250 tok
  read-clamp                1 calls        15,000 tok
```

The HTML variant renders a daily bar chart you can screenshot for PR descriptions. Pricing is configurable — set `tokenomy config set report.price_per_million 15` for Opus-input rates.

---

## 🔬 `tokenomy analyze`

`report` shows what the live hooks already saved. `analyze` goes further: it walks the **raw session transcripts** of Claude Code (`~/.claude/projects/**/*.jsonl`) *and* Codex CLI (`~/.codex/sessions/**/*.jsonl`), replays the full Tokenomy rule pipeline over every historical tool call with a real tokenizer, and tells you exactly how much you *would have* saved if Tokenomy had been installed from day one — plus where the waste actually concentrates today.

```bash
tokenomy analyze                              # default: scan last 30 days, top 10 tools
tokenomy analyze --since 7d                   # last week
tokenomy analyze --since 2026-04-01           # from a specific date
tokenomy analyze --project Tokenomy           # filter by project dir substring
tokenomy analyze --session 6689da94           # one session
tokenomy analyze --tokenizer tiktoken         # accurate cl100k counts (see below)
tokenomy analyze --json                       # machine-readable
tokenomy analyze --verbose                    # include per-day breakdown
```

The default output is a fancy CLI dashboard: rounded-box header, per-rule savings bars, top-N waste leaderboard, duplicate hotspots, largest individual tool results, and an inline sparkline by day. Pipe to a file or use `--no-color` to disable ANSI.

### Tokenizer choice

- **`heuristic`** (default) — zero-dep word/punctuation splitter calibrated for code + JSON. Accurate to ~±10% on typical tool responses.
- **`tiktoken`** — real `cl100k_base` counts via `js-tiktoken`. A solid Claude-token approximation (Anthropic doesn't publish Claude 4's BPE). Install with `npm i -g js-tiktoken` and pass `--tokenizer=tiktoken`.
- **`auto`** — use tiktoken if present, else heuristic.

### Sample output

```
╭────────────────────────── tokenomy analyze ──────────────────────────╮
│ Window: 2026-04-17T10:00:00Z  →  2026-04-18T19:59:18Z                │
│ Tokenizer: heuristic (approximate)                                   │
╰──────────────────────────────────────────────────────────────────────╯

Summary
  Files scanned              4     Sessions       2
  Tool calls parsed        299     Duplicate calls 1
  Tokens observed       89,562     ~USD observed  $0.2687
  Tokens Tokenomy would save  1,926  (2.2% of observed)
  ~USD Tokenomy would save   $0.0058

Savings by rule
  Duplicate-response dedup       ████████████████████████   1,926 tok
  Read clamp                     ████░░░░░░░░░░░░░░░░░░░░     324 tok

Duplicate hotspots  (same args, repeated within a session)
  Read                     2×      2,263 tok wasted
  Read                     2×      1,965 tok wasted
  ...
```

`analyze` never modifies anything; it just reads. The transcript parser handles both Claude Code's `assistant.message.content[].tool_use` → `user.message.content[].tool_result` pairing and Codex CLI's `payload.tool_call` rollout shape.

---

## 🕸️ Code-graph MCP server (agent-agnostic, Phase 3)

Once the live hooks stop bleeding tokens on tool chatter, the next waste is the agent reading half a codebase to find one function. The optional **`tokenomy-graph` MCP server** gives the agent five surgical tools over stdio — the graph is built once, queries return focused neighborhoods, budgets are hard-capped. Works with both Claude Code and Codex CLI.

### Install + register (Claude Code)

```bash
npm install -g typescript              # peer-optional; required for the graph
tokenomy init --graph-path "$PWD"      # adds tokenomy-graph to ~/.claude/settings.json
tokenomy graph build --path "$PWD"     # parses TS/JS into ~/.tokenomy/graphs/<id>/
tokenomy doctor                        # 12/12 ✓
# restart Claude Code
```

### Install + register (Codex CLI)

```bash
npm install -g typescript
codex mcp add tokenomy-graph -- tokenomy graph serve --path "$PWD"
tokenomy graph build --path "$PWD"
codex mcp list                         # verify tokenomy-graph is registered
```

### The five tools

| Tool | Input | Output | Budget |
|---|---|---|---|
| `build_or_update_graph` | `{force?, path?}` | build stats | 4 KB |
| `get_minimal_context` | `{target: {file, symbol?}, depth?}` | focal + ranked neighbors (imports/exports/contains) | 4 KB |
| `get_impact_radius` | `{changed: [{file, symbols?}], max_depth?}` | reverse deps + suggested tests | 6 KB |
| `get_review_context` | `{files: [...]}` | fanout + hotspots across changed files | 1 KB |
| `find_usages` | `{target: {file, symbol?}}` | direct callers, references, importers (forward lookup) | 4 KB |

Stale detection is always-on: queries return `{stale, stale_files}` so the agent knows whether to trust the result. `tokenomy graph build --force` regenerates. An in-memory LRU cache keyed on `(tool, args, meta.built_at)` keeps repeated queries fast and auto-invalidates when the graph is rebuilt.

### Good prompt to test it

> First call `build_or_update_graph` if needed.
> Then call `get_minimal_context` for `{"target":{"file":"src/index.ts"},"depth":1}`.
> Then call `get_review_context` for `{"files":["src/index.ts","src/foo.ts"]}`.
> Only use `Read` if the graph result is insufficient.

### Dev CLI (no MCP needed)

```bash
tokenomy graph status --path "$PWD"
tokenomy graph query minimal --path "$PWD" --file src/index.ts
tokenomy graph query impact  --path "$PWD" --file src/index.ts
tokenomy graph query review  --path "$PWD" --files src/index.ts,src/foo.ts
tokenomy graph query usages  --path "$PWD" --file src/foo.ts
tokenomy graph purge [--all]
```

### Scope + limits (v1)

- **TypeScript + JavaScript only** (`.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`, with `.mts`/`.cts` probed). Python / 23-lang support explicitly out of scope.
- **Soft cap 2 000 files, hard cap 5 000** — larger repos abort cleanly with `repo-too-large`.
- **AST-only** via the TypeScript compiler API (no type checker); type-only imports and JSX element references skipped in v1.
- **No `tsconfig.paths`, no `node_modules` resolution** — bare specifiers become `external-module` nodes. Will revisit in v2.
- **Fail-open always:** every tool and CLI subcommand returns `{ok: false, reason}` rather than throwing; graph features never break the core hook path.

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
- [ ] **Phase 5.** Polish — statusline with live savings counter, `UserPromptSubmit` prompt-classifier for effort-level nudges, Python parser plugin for the graph, npm publish at 1.0.

---

## 🤝 Contribute

Contributions are very welcome. The repo is still small, dependency-light (zero runtime deps in the hot hook path; `@modelcontextprotocol/sdk` loaded dynamically for the graph server only; `js-tiktoken` is an optional peer dep for accurate `analyze` token counts), and test-first (213/213 currently green).

### Good first issues

| Difficulty | What | Where |
|---|---|---|
| 🟢 easy | Add a synthetic fixture for a real-world MCP tool you use (Asana, HubSpot, etc.) and a rule-level test | `tests/fixtures/` + `tests/unit/mcp-content.test.ts` |
| 🟢 easy | Add more `analyze` transcript parser support (other Codex rollout shapes, OpenCode, Aider) | `src/analyze/parse.ts` |
| 🟡 medium | Add a built-in trim profile for another MCP server you use | `src/rules/profiles.ts` |
| 🟡 medium | Statusline script (`bin/tokenomy-statusline`) that consumes Claude Code's statusline stdin and renders live savings | new `src/statusline/` |
| 🔴 hard | Phase 4 Bash input-bounder — shell-aware parsing to detect commands lacking any existing bound | new `src/rules/bash-bound.ts` |
| 🔴 hard | Python parser plugin for the graph MCP server — spawn `python -c "import ast"` and extract imports/defs | new `src/parsers/py/` |

### Architecture tour

```
src/
  core/     — types, config (+ per-tool overrides), paths, gate, log, dedup, recovery hint
  rules/    — pure transforms: mcp-content, read-bound, bash-bound, text-trim, profiles, stacktrace, redact
  hook/     — entry.ts + dispatch.ts + pre-dispatch.ts (stdin → rule → stdout)
  analyze/  — transcript scanner (Claude Code + Codex), parse, tokens, simulate, report, render
  graph/    — schema, build, stale detection, repo-id, query/{minimal,impact,review,usages,budget,common}
  mcp/      — stdio server, tool handlers, schema definitions, query-cache (LRU), budget-clip
  parsers/  — TS/JS AST extraction
  cli/      — init, doctor (+ --fix), uninstall, config-cmd, report, analyze, graph, entry
  util/     — settings-patch, manifest, atomic-write, backup, json helpers

tests/
  unit/         — one file per module, ≥1 trim + ≥1 passthrough per rule
  integration/  — spawn compiled dist/hook/entry.js or dist/cli/entry.js as subprocess
  fixtures/     — synthetic graph repos + synthesized transcripts for analyze
```

Rules are pure functions: `(toolName, toolInput, toolResponse, config) → { kind: "passthrough" | "trim", ... }`. Adding a new rule is a one-file drop-in.

### Development

Clone, build, and `npm link` so the `tokenomy` command points at your local checkout:

```bash
git clone https://github.com/RahulDhiman93/Tokenomy.git
cd Tokenomy
npm install
npm run build        # tsc + chmod +x
npm test             # node:test runner, 213 tests, ~2 s
npm run coverage     # c8 → coverage/lcov.info + HTML report
npm run typecheck    # tsc --noEmit
npm link             # overrides any installed `tokenomy` with your local build
tokenomy doctor      # 12/12 ✓
tokenomy analyze     # benchmarks your real transcripts
```

Revert to the published version later with `npm unlink -g tokenomy && npm install -g tokenomy`.

Current coverage: **96 % statements · 85 % branches · 100 % functions.**

### Guiding principles

1. **Fail-open always.** A broken hook is worse than no hook. Never exit 2, never break Claude's workflow.
2. **Schema invariants over trust.** Test that rule outputs never fabricate keys, flip types, or shrink arrays.
3. **Path-match over markers.** Uninstall identifies entries by absolute command path, not by injected `_tokenomy: true` keys — Claude Code's schema may tighten tomorrow.
4. **Measure before bragging.** No "X % savings" claims in code or docs until Phase 2 benchmarks them against a real corpus.
5. **Small and legible.** If a dependency shaves a dozen lines at the cost of a 200 KB install, it's a no.

### Before opening a PR

- `npm test` green (including any new unit + integration tests for your change)
- If you touched a rule: add a fixture-pair or inline-assertion test for passthrough *and* trim cases
- If you touched `init`/`uninstall`: extend the round-trip integration test
- If you added a config field: document in the README config block

Questions? Open a discussion. This is an alpha — design-level feedback is as welcome as code.

---

## 📜 License

MIT — see [LICENSE](./LICENSE).

<div align="center">

<img alt="Tokenomy mark" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/png/mark-primary-512-2x.png" width="56">

*Save tokens. Save money. Save the rainforest — or at least your API bill.*

</div>
