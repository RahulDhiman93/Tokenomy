<div align="center">

# Tokenomy

### Stop burning tokens on tool chatter.

A surgical Claude Code hook that transparently trims bloated MCP responses and clamps oversized file reads — so your agent spends tokens on *thinking*, not on parsing 40 KB of Jira JSON for the third time.

[![CI](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/.github/badges/coverage.json&cacheSeconds=300)](#contribute)
[![npm](https://img.shields.io/npm/v/tokenomy.svg?label=npm&color=cb0000&cacheSeconds=300)](https://www.npmjs.com/package/tokenomy)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#quickstart)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Phase](https://img.shields.io/badge/phase%203.5-alpha-blue)](#roadmap)

</div>

---

## 🩻 The pain

Your last long Claude Code session looked something like this:

```
Assistant → get_jira_issue        ← 40 KB
Assistant → search_jira_jql       ← 85 KB
Assistant → read src/server.ts    ← 18 KB  (2000 lines)
Assistant → read src/server.ts    ← 18 KB  (same file, again)
Assistant → read src/config.ts    ← 14 KB
...
```

200 K tokens gone before Claude did any real work. **Compaction kicks in too late, and it's lossy.**

Tokenomy plugs the holes the Claude Code hook contract lets you close — with zero proxy, no monkey-patching:

| Surface | Mechanism | What it kills |
|---|---|---|
| `PostToolUse` on `mcp__.*` | `updatedMCPToolOutput` (multi-stage: redact → stacktrace collapse → schema-aware profile → byte trim) | 10–50 KB MCP responses from Atlassian, Notion, Gmail, Asana, HubSpot, Intercom… |
| `PostToolUse` on `mcp__.*` | duplicate-response dedup (per session) | Repeated identical tool calls — second hit returns a pointer stub, not a 30 KB refetch |
| `PreToolUse` on `Read` | `updatedInput` | Unbounded reads on huge source files |
| `tokenomy-graph` MCP server | 5 tools over stdio | Brute-force `Read` sweeps of the codebase — agent gets focused context from a pre-built graph |

Each trim appends a row to `~/.tokenomy/savings.jsonl` with measured bytes-in / bytes-out, so you can prove the savings. Run `tokenomy report` for a TUI + HTML digest.

---

## ⚡ Quickstart

```bash
npm install -g tokenomy
tokenomy init          # patches ~/.claude/settings.json (backed up first)
tokenomy doctor        # 9/9 ✓
# restart Claude Code
```

That's it. Use Claude Code normally. Tokenomy does the rest.

> **Still pre-`1.0`.** Every release carries an `-alpha.N` suffix and breaking changes may land on minor bumps — the [CHANGELOG](./CHANGELOG.md) calls them out. Users who want stability should pin a specific version: `npm install -g tokenomy@0.1.0-alpha.6`.

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
   ┌─────────────────────── Claude Code ───────────────────────┐
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
```

### Under the hood

**Multi-stage MCP pipeline (`PostToolUse`).** For every `mcp__.*` response, Tokenomy runs four stages in order:

1. **Duplicate dedup** — if this exact `(tool, canonicalized-args)` was seen earlier in the same session and is still within `cfg.dedup.window_seconds`, the body is replaced with a short pointer stub (`[tokenomy: duplicate of call #N at <time> — no refetch required.]`). Session-scoped ledger lives under `~/.tokenomy/dedup/<session>.jsonl`.
2. **Secret redactor** — regex sweep catches AWS access keys, GitHub PATs, OpenAI/Anthropic API keys, Slack tokens, Stripe keys, Google API keys, JWTs, Bearer tokens, and PEM private key blocks. Replaced with `[tokenomy: redacted <kind>]`. Force-applies even when byte savings are below the gate threshold (security > tokens).
3. **Stacktrace collapser** — detects Node, Python, Java, Ruby error shapes and keeps error header + first frame + last 3 frames, eliding the middle.
4. **Schema-aware trim profiles** — parses JSON responses and keeps a curated set of keys (title/status/assignee/body/etc.), truncating long strings and overflowing arrays with explicit markers. Ships with built-ins for Atlassian Jira/Confluence, Linear, Slack, Gmail, and GitHub; users can register custom profiles in config.
5. **Byte-trim fallback** — if stages 1–4 together still exceed `cfg.mcp.max_text_bytes`, the remaining text block is head+tail trimmed with an explicit `[tokenomy: elided N bytes]` marker. A footer block tells Claude how to re-invoke for full detail.

`content.length` never shrinks, `is_error` flows through, non-text blocks (images, resources) pass through untouched, and unknown top-level keys are preserved. Each trim's `reason` reports which stages fired (e.g. `redact:3+profile:atlassian-jira-issue`).

**Read clamp (`PreToolUse`).** If Claude's `Read` call has an explicit `limit` or `offset`, passthrough — respect user intent. Otherwise, stat the file. Under threshold → passthrough. Over threshold → inject `limit: N` plus an `additionalContext` note so Claude knows it can offset-Read more regions.

**Fail-open is a non-negotiable.** Malformed stdin, parse errors, unknown shapes → exit 0 with empty stdout (true passthrough). 10 MB stdin cap. 2.5 s internal timeout. Exit code 2 (blocking) is never used. Breaking Claude is worse than wasting tokens.

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

## 🕸️ Code-graph MCP server (opt-in, Phase 3)

Once the two hooks stop bleeding tokens on tool chatter, the next waste is Claude reading half a codebase to find one function. The optional **`tokenomy-graph` MCP server** gives the agent four surgical tools over stdio — the graph is built once, queries return focused neighborhoods, budgets are hard-capped.

### Install + register

```bash
npm install -g typescript              # peer-optional; required for the graph
tokenomy init --graph-path "$PWD"      # adds tokenomy-graph to ~/.claude/settings.json
tokenomy graph build --path "$PWD"     # parses TS/JS into ~/.tokenomy/graphs/<id>/
tokenomy doctor                        # 10/10 ✓
# restart Claude Code
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

### Codex

The MCP server ports cleanly:

```bash
codex mcp add tokenomy-graph -- tokenomy graph serve --path "$PWD"
codex mcp list
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

- [x] **Phase 1.** `PostToolUse` MCP trim + `PreToolUse` Read clamp + CLI + 12-check doctor + savings log
- [ ] **Phase 2.** `tokenomy analyze` — walk `~/.claude/projects/**/*.jsonl`, surface waste patterns, benchmark real savings with a real tokenizer
- [x] **Phase 3.** Local code-graph MCP server: `tokenomy-graph` stdio server + `graph build|status|serve|query|purge` CLI + `init --graph-path` + doctor check. TypeScript AST, 5 tools, hard budget caps, fail-open everywhere.
- [x] **Phase 3.5.** Multi-stage PostToolUse pipeline: duplicate-response dedup, secret redaction, stacktrace collapse, schema-aware trim profiles (Atlassian/Linear/Slack/Gmail/GitHub), per-tool config overrides, `find_usages` graph tool, MCP query LRU cache, `tokenomy report` (TUI + HTML), hook perf telemetry, `doctor --fix`.
- [ ] **Phase 4.** `PreToolUse` Bash input-bounder (auto-append `| head -N` on verbose commands) + hinting layer nudging Claude toward Tokenomy MCP alternatives
- [ ] **Phase 5.** Polish — statusline with live savings counter, `UserPromptSubmit` prompt-classifier for effort-level nudges, npm publish

---

## 🤝 Contribute

Contributions are very welcome. The repo is still small, dependency-light (zero runtime deps in the hot hook path; `@modelcontextprotocol/sdk` loaded dynamically for the graph server only), and test-first (128/128 currently green).

### Good first issues

| Difficulty | What | Where |
|---|---|---|
| 🟢 easy | Add a synthetic fixture for a real-world MCP tool you use (Asana, HubSpot, etc.) and a rule-level test | `tests/fixtures/` + `tests/unit/mcp-content.test.ts` |
| 🟢 easy | Make `tokenomy analyze` (Phase 2) — read `~/.claude/projects/**/*.jsonl`, aggregate `tokens_saved_est` by tool | new `src/cli/analyze.ts` |
| 🟡 medium | Add a "structured JSON" trim rule — when an MCP text block is valid JSON, trim the parsed structure instead of the raw text | new `src/rules/json-aware.ts` |
| 🟡 medium | Statusline script (`bin/tokenomy-statusline`) that consumes Claude Code's statusline stdin and renders live savings | new `src/statusline/` |
| 🔴 hard | Phase 3 MCP companion server (stdio transport). Main scaffolding done in spec; needs implementation | new `src/mcp/` |
| 🔴 hard | Phase 4 Bash input-bounder — shell-aware parsing to detect commands lacking any existing bound | new `src/rules/bash-bound.ts` |

### Architecture tour

```
src/
  core/     — types, config (+ per-tool overrides), paths, gate, log, dedup, recovery hint
  rules/    — pure transforms: mcp-content, read-bound, text-trim, profiles, stacktrace, redact
  hook/     — entry.ts + dispatch.ts + pre-dispatch.ts (stdin → rule → stdout)
  graph/    — schema, build, stale detection, repo-id, query/{minimal,impact,review,usages,budget,common}
  mcp/      — stdio server, tool handlers, schema definitions, query-cache (LRU), budget-clip
  parsers/  — TS/JS AST extraction
  cli/      — init, doctor (+ --fix), uninstall, config-cmd, report, graph, entry
  util/     — settings-patch, manifest, atomic-write, backup, json helpers

tests/
  unit/         — one file per module, ≥1 trim + ≥1 passthrough per rule
  integration/  — spawn compiled dist/hook/entry.js as subprocess
  fixtures/     — synthetic repos for graph tests; will host real captured MCP responses (Phase 2)
```

Rules are pure functions: `(toolName, toolInput, toolResponse, config) → { kind: "passthrough" | "trim", ... }`. Adding a new rule is a one-file drop-in.

### Development

Clone, build, and `npm link` so the `tokenomy` command points at your local checkout:

```bash
git clone https://github.com/RahulDhiman93/Tokenomy.git
cd Tokenomy
npm install
npm run build        # tsc + chmod +x
npm test             # node:test runner, 128 tests, ~2 s
npm run coverage     # c8 → coverage/lcov.info + HTML report
npm run typecheck    # tsc --noEmit
npm link             # overrides any installed `tokenomy` with your local build
tokenomy doctor      # 12/12 ✓
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

*Save tokens. Save money. Save the rainforest — or at least your API bill.*

</div>
