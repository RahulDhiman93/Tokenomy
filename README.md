<div align="center">

# Tokenomy

### Stop burning tokens on tool chatter.

A surgical Claude Code hook that transparently trims bloated MCP responses and clamps oversized file reads — so your agent spends tokens on *thinking*, not on parsing 40 KB of Jira JSON for the third time.

[![CI](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/.github/badges/coverage.json&cacheSeconds=300)](#contribute)
[![npm](https://img.shields.io/npm/v/tokenomy.svg?label=npm&color=cb0000)](https://www.npmjs.com/package/tokenomy)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#quickstart)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Phase](https://img.shields.io/badge/phase%201-alpha-blue)](#roadmap)

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

Tokenomy plugs two holes the Claude Code hook contract actually lets you close — with zero proxy, no monkey-patching, and a total of ~800 lines of TypeScript:

| Surface | Mechanism | What it kills |
|---|---|---|
| `PostToolUse` on `mcp__.*` | `updatedMCPToolOutput` | 10–50 KB MCP responses from Atlassian, Notion, Gmail, Asana, HubSpot, Intercom… |
| `PreToolUse` on `Read` | `updatedInput` | Unbounded reads on huge source files |

Each trim appends a row to `~/.tokenomy/savings.jsonl` with measured bytes-in / bytes-out, so you can prove the savings.

---

## ⚡ Quickstart

```bash
git clone <this-repo> && cd tokenomy
npm install && npm run build && npm link
tokenomy init        # patches ~/.claude/settings.json (backed up first)
tokenomy doctor      # 9/9 ✓
# restart Claude Code
```

That's it. Use Claude Code normally. Tokenomy does the rest.

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

**MCP trim (`PostToolUse`).** Claude Code surfaces MCP tool results either as `{content: [...]}` (spec shape) or a raw `[...]` array (Claude.ai connectors). The hook handles both. Text blocks are head+tail trimmed with an explicit `[tokenomy: elided N bytes]` marker; non-text blocks (images, resources) pass through untouched in their original position; a footer block tells Claude how to re-invoke for full detail. `content.length` never shrinks, `is_error` flows through, unknown top-level keys preserved.

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
    "max_text_bytes":   16000,
    "per_block_head":    4000,
    "per_block_tail":    2000
  },
  "read": {
    "enabled":            true,
    "clamp_above_bytes": 40000,
    "injected_limit":      500
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

9/9 checks passed
```

Every check has an actionable remediation hint on failure.

---

## 🛑 Uninstall

```bash
tokenomy uninstall --purge
```

Removes both hook entries from `~/.claude/settings.json` (matched by absolute command path — no brittle markers), deletes `~/.tokenomy/`, and your original `settings.json` remains backed up at `~/.claude/settings.json.tokenomy-bak-<timestamp>`.

---

## 🧭 Roadmap

- [x] **Phase 1.** `PostToolUse` MCP trim + `PreToolUse` Read clamp + CLI + 9-check doctor + savings log
- [ ] **Phase 2.** `tokenomy analyze` — walk `~/.claude/projects/**/*.jsonl`, surface waste patterns, benchmark real savings with a real tokenizer
- [ ] **Phase 3.** Portable MCP companion server — `tokenomy_summarize`, `tokenomy_read_slice`, `tokenomy_grep_bucketed`. Works in Codex via `~/.codex/config.toml`
- [ ] **Phase 4.** `PreToolUse` Bash input-bounder (auto-append `| head -N` on verbose commands) + hinting layer nudging Claude toward Tokenomy MCP alternatives
- [ ] **Phase 5.** Polish — statusline with live savings counter, `UserPromptSubmit` prompt-classifier for effort-level nudges, npm publish

---

## 🤝 Contribute

Contributions are very welcome. The repo is small (~800 LOC), dependency-light (zero runtime deps, `tsx` + `typescript` + `@types/node` in dev), and test-first (41/41 currently green).

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
  core/     — types, config, paths, gate, log, recovery hint
  rules/    — pure transforms: mcp-content, read-bound, text-trim
  hook/     — entry.ts + dispatch.ts + pre-dispatch.ts (stdin → rule → stdout)
  cli/      — init, doctor, uninstall, config-cmd, entry
  util/     — settings-patch, manifest, atomic-write, backup, json helpers

tests/
  unit/         — one file per module, ≥1 trim + ≥1 passthrough per rule
  integration/  — spawn compiled dist/hook/entry.js as subprocess
  fixtures/     — will host real captured MCP responses (Phase 2)
```

Rules are pure functions: `(toolName, toolInput, toolResponse, config) → { kind: "passthrough" | "trim", ... }`. Adding a new rule is a one-file drop-in.

### Development

```bash
npm install
npm run build        # tsc + chmod +x
npm test             # node:test runner, 41 tests, <1 s
npm run coverage     # c8 → coverage/lcov.info + HTML report
npm run typecheck    # tsc --noEmit
npm run build && npm link && tokenomy doctor    # end-to-end smoke
```

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
