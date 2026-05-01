<div align="center">

<img alt="Tokenomy" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/logo.jpg" width="200">

### Stop burning tokens on tool chatter.

A surgical hook + analysis toolkit for **Claude Code, Codex CLI, Cursor, Windsurf, Cline, and Gemini** that transparently trims bloated MCP responses, clamps oversized file reads, bounds verbose shell commands, dedupes repeat calls, compresses agent memory files, and benchmarks waste.

[![CI](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/RahulDhiman93/Tokenomy/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/.github/badges/coverage.json&cacheSeconds=300)](#contribute)
[![npm](https://img.shields.io/npm/v/tokenomy.svg?label=npm&color=cb0000&cacheSeconds=300)](https://www.npmjs.com/package/tokenomy)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](#quickstart)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](#license)
[![Phase](https://img.shields.io/badge/phase%205-beta-blue)](#roadmap)

</div>

---

## 🩻 Why

Long agent sessions burn 100k+ tokens on tool chatter before the agent does any real work. Compaction kicks in too late and is lossy.

Tokenomy plugs the holes the hook contracts let you close — zero proxy, no monkey-patching:

- **Live trimming** — MCP/Bash/Read/Write hooks shrink responses the moment they fire
- **Code-graph MCP** — focused context retrieval instead of brute-force `Read` sweeps
- **Agent nudges** — redirect waste before it happens (OSS alternatives, prompt classifier)
- **Golem** — terse-output mode (the one surface other features leave alone — assistant output is billed 5× input on Sonnet)
- **Raven** — Claude/Codex cross-agent handoff + review bridge
- **Observability** — `savings.jsonl`, `tokenomy report`, `tokenomy analyze`, statusline, doctor

Each live trim appends a row to `~/.tokenomy/savings.jsonl` with measured bytes-in / bytes-out. Run `tokenomy report` for a digest, or `tokenomy analyze` to benchmark historical waste from session transcripts.

---

## ⚡ Quickstart

```bash
npm install -g tokenomy
tokenomy init --graph-path "$PWD"   # patches Claude/Cursor/Windsurf/Cline/Gemini graph configs, Codex hooks + builds the graph
tokenomy doctor                     # all checks passing
# restart Claude Code — done
```

Codex CLI hooks plus Cursor, Windsurf, Cline, and Gemini graph MCP configs are auto-detected when each is on PATH. Force one target with `--agent <name>`; inspect first with `tokenomy init --list-agents`.

> **Pre-`1.0`.** Breaking changes may land before `1.0.0` (see [CHANGELOG](./CHANGELOG.md)). Pin: `npm install -g tokenomy@0.1.7`. Upgrade: `tokenomy update`.

---

## <img src="https://claude.ai/apple-touch-icon.png" alt="Claude" width="22" style="vertical-align: middle;"> Zero-touch interactive install via Claude Code

Paste this into Claude Code. The agent installs Tokenomy with the graph MCP where supported, then walks you through each opt-in feature one at a time so you can pick what fits your workflow.

```
Install tokenomy for me, then walk me through the optional features one by one.

Step 1 — Install the core:
  1. Run: npm install -g tokenomy
  2. Run: tokenomy init --graph-path "$PWD"
     (patches Claude Code config, registers the tokenomy-graph MCP server
      for this repo, and builds the code graph)
  3. Run: tokenomy doctor

Step 2 — Then ask me about each optional feature, one at a time.
  For each feature: give me a 2-3 sentence explanation of what it does,
  what it costs (tokens / latency / friction), and a yes/no question.
  Wait for my answer before moving on. Apply the install command for
  features I say yes to. Skip features I say no to.

  Walk through these features in order:

  a) Golem — terse-output mode plugin. Five modes from `lite`
     (drop hedging) up to `recon` (zero banter, info-density only).
     Cuts assistant output tokens 20-65 % depending on mode. Ask me
     which mode I want, or whether to skip entirely.
     Install: tokenomy golem enable --mode=<chosen>

  b) Raven bridge — Claude Code + Codex CLI cross-agent handoff +
     review packets. Useful only if I have Codex CLI on PATH and I
     actually do code review with both agents. Skip if I only use
     Claude.
     Install: tokenomy raven enable

  c) OSS-alternatives nudge (Write intercept) — when I'm about to
     create a new utility-ish file > 500 B, Tokenomy reminds me to
     check `find_oss_alternatives` first. Catches reinventing-the-wheel
     work. Default ON; ask if I want it off.
     Disable: tokenomy config set nudge.write_intercept.enabled false

  d) Prompt-classifier nudge — fires once per turn when I prompt
     "any existing library for X" / "alternative to Y" / "instead of
     building Z". Conservative since 0.1.2 (was overly broad before).
     Default ON; ask if I want it off.
     Disable: tokenomy config set nudge.prompt_classifier.enabled false

  e) Pre-call redact — extends secret redaction to PreToolUse on
     Bash/Write/Edit. Catches API keys, tokens, JWTs, PEM blocks
     before they hit the assistant. Default OFF; ask if I want it on
     (recommended if I work with credentials).
     Enable: tokenomy config set redact.pre_tool_use true

  e.5) Kratos — security shield. Continuously scans my prompts for
     prompt-injection ("ignore previous instructions"), data-exfil
     requests, secrets I accidentally pasted, hidden zero-width chars.
     Also runs `tokenomy kratos scan` to audit installed MCP servers
     for read-source ↔ write-sink combos that form an exfil route.
     Default OFF. Strongly recommended if I have any third-party MCP
     servers (Slack, Gmail, Atlassian, etc.) installed. Ask me yes/no.
     Enable: tokenomy kratos enable
     One-shot audit: tokenomy kratos scan

  f) Budget pre-flight — advisory PreToolUse rule that warns when a
     call would push my session past a token cap. Never blocks.
     Default OFF; ask if I want it on with what cap.
     Enable: tokenomy config set budget.session_cap_tokens 200000

  g) Statusline — one-line live savings counter. Shows version,
     Golem mode, graph freshness, today's trims, and a `↑` after the
     version when an update is available. Already wired by `init`;
     just confirm it's working and move on.

  h) Live graph freshness (0.1.3+) — graph stays fresh during the
     session. PostToolUse hook on Edit/Write/MultiEdit drops a
     `.dirty` sentinel; the next graph query rebuilds in the
     background. ON by default. Tell me whether to keep it ON
     (recommended) or disable.
     Disable: tokenomy config set graph.async_rebuild false

  i) Multi-repo graph + Raven (0.1.3+) — register the graph in EACH
     repo I want it for. Run `tokenomy init --graph-path "$PWD"` in
     each project root. When working across repos in one Claude
     session, agents should pass `path: "$PWD"` to the MCP tools so
     Tokenomy resolves the right per-repo graph + Raven store.
     No-op for single-repo workflows.

  j) Auto update-check (0.1.3+) — SessionStart fires
     `tokenomy update --check --quiet` (detached, fail-open,
     throttled 3h) so a new release shows up in the statusline `↑`
     marker on the next Claude restart. ON by default. No action
     needed; just confirm.

  k) Diagnose (0.1.5+) — `tokenomy diagnose` emits a JSON health
     report covering every feature + environment. Useful for paste
     into `tokenomy feedback` when something looks wrong. No
     install action needed; just demo it once and move on.
     Demo: tokenomy diagnose

Step 3 — Final check:
  1. Run: tokenomy doctor
  2. Tell me to fully quit Claude Code (Cmd+Q) and reopen so the new
     hooks + MCP server + SessionStart preamble load cleanly.
```

---

## 🧭 Features

Each feature has its own README. Main README stays small.

| Area | What | Docs |
|---|---|---|
| Live token trimming | MCP / Bash / Read / Write / Edit hooks — multi-stage pipeline, dedup, redact, stacktrace collapse, schema profiles, shape-trim, byte-trim | [docs/features/live-trimming.md](./docs/features/live-trimming.md) |
| Code-graph MCP | `tokenomy-graph` stdio server — `get_minimal_context`, `get_impact_radius`, `get_review_context`, `find_usages`, `find_oss_alternatives` | [docs/features/code-graph.md](./docs/features/code-graph.md) |
| Agent nudges | OSS-alternatives Write nudge, prompt-classifier, repo-search relevance gate | [docs/features/agent-nudges.md](./docs/features/agent-nudges.md) |
| Golem | Terse output mode — `lite` / `full` / `ultra` / `grunt` / `recon` / `auto`. Safety-gated for code, commands, warnings, numbers | [docs/features/golem.md](./docs/features/golem.md) |
| Raven bridge | Claude-primary + Codex-reviewer handoff packets, deterministic finding compare, PR-readiness verdict | [docs/features/raven.md](./docs/features/raven.md) |
| Kratos *(0.1.2+)* | Security shield — prompt-injection / data-exfil / secret-in-prompt detector + cross-MCP exfil-pair scanner | [docs/features/kratos.md](./docs/features/kratos.md) |
| Feedback *(0.1.2+)* | `tokenomy feedback "..."` files a GitHub issue (via `gh` or browser fallback). No backend service. | [docs/features/feedback.md](./docs/features/feedback.md) |
| Diagnose *(0.1.5+)* | `tokenomy diagnose [--json]` — single-shot health report covering every feature + environment. Designed to paste into `tokenomy feedback`. | [docs/features/diagnose.md](./docs/features/diagnose.md) |
| Observability | `savings.jsonl`, `report`, `analyze`, `diff`, `learn`, `budget`, `bench`, `status-line`, `doctor`, `update` | [docs/features/observability.md](./docs/features/observability.md) |
| Compress | `tokenomy compress` — agent rule file cleanup (CLAUDE.md, AGENTS.md, .cursor/rules) | [docs/features/compress.md](./docs/features/compress.md) |
| Cross-agent install | Per-agent adapters for Claude / Codex / Cursor / Windsurf / Cline / Gemini | [docs/features/cross-agent.md](./docs/features/cross-agent.md) |
| Configure | `~/.tokenomy/config.json` — full reference + common tweaks | [docs/features/configure.md](./docs/features/configure.md) |

---

## 💸 Real savings from one dogfood session

Tokenomy run on its own repo in a fresh Claude Code session (Bash verbose commands, Read on a large file, five graph MCP queries):

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

~20k tokens saved per event. A dev spending 4 agent-hours a day reclaims ~$10/week. Reproduce via `CONTRIBUTING.md`'s dogfood playbook.

---

## 🩺 `tokenomy doctor`

```
✓ Node ≥ 20
✓ ~/.claude/settings.json parses
✓ Hook entries present (PostToolUse + PreToolUse + UserPromptSubmit + SessionStart)
✓ PreToolUse matcher covers Read + Bash + Write + Edit — Read|Bash|Write|Edit
✓ Hook binary exists + executable
✓ Smoke spawn hook (empty mcp call) — exit=0 elapsed=74ms
✓ ~/.tokenomy/config.json parses
✓ Log directory writable
✓ Manifest drift — clean
✓ No overlapping mcp__ hook — clean
✓ Graph MCP registration — tokenomy-graph configured in ~/.claude.json
✓ Statusline registered — tokenomy status-line
✓ Agent detection — claude-code, codex, cursor
✓ Graph MCP SDK available — @modelcontextprotocol/sdk import ok
✓ Hook perf budget — p50=5ms p95=12ms max=14ms (n=30, budget 50ms)
✓ Graph dirty sentinel age — no pending sentinel
✓ Raven store size — 0.0 MB
✓ Savings log size — 1.2 MB
✓ Update cache age — 12min old

19/19 checks passed
```

Every check has an actionable remediation hint on failure. `tokenomy doctor --fix` for routine repair.

---

## 🛑 Uninstall

```bash
tokenomy uninstall --purge
```

Removes both hook entries from `~/.claude/settings.json` (matched by absolute command path), deletes `~/.tokenomy/`. Original `settings.json` remains backed up at `~/.claude/settings.json.tokenomy-bak-<timestamp>`.

---

## 🧭 Roadmap

- [x] **Phase 1.** `PostToolUse` MCP trim + `PreToolUse` Read clamp + CLI + 12-check doctor + savings log (Claude Code).
- [x] **Phase 2.** `tokenomy analyze` — walks Claude Code + Codex CLI transcripts, replays rules with a real tokenizer.
- [x] **Phase 3.** Local code-graph MCP server: `tokenomy-graph` stdio server. Works with both Claude Code and Codex CLI.
- [x] **Phase 3.5.** Multi-stage PostToolUse pipeline: dedup, secret redact, stacktrace collapse, schema-aware profiles.
- [x] **Phase 4.** `PreToolUse` Bash input-bounder.
- [x] **Phase 4.5.** OSS-alternatives-first nudge — `find_oss_alternatives` MCP tool + Write context nudge.
- [x] **Phase 5.** Polish — Golem output mode, statusline, prompt-classifier, `compress`, `bench`, cross-agent installers.
- [x] **Phase 5.5.** Codex hook foothold — user-scoped `SessionStart` + `UserPromptSubmit` hooks for Golem and prompt-classifier nudges.
- [x] **Phase 6 (0.1.x).** Raven bridge, Kratos security shield, statusline update marker, Raven in report/analyze, Golem `recon` mode, `tokenomy feedback` command, live graph freshness + cross-repo isolation + auto-update-check (0.1.3), Kratos statusline badge (0.1.4), `tokenomy diagnose` + production-hardening pass + RECON v2 (0.1.5), production-scale graph defaults (0.1.6), Codex MCP startup hotfix + hot-path git timeouts + build-lock stale reclaim + Windows `commandExists` + init rollback + redact-pre size cap + bounded session-state read + debug-log secret hygiene + realpath identity (0.1.7).
- [ ] **Phase 7.** Language breadth — Python parser plugin, richer benchmark fixtures, npm publish at 1.0.
- [ ] **Phase 8.** Agent operating layer — rule-pack generator, compaction-time memory hygiene, workflow MCP tools, session ledgers, team-ready reports. See [docs/NEXT_FEATURES.md](./docs/NEXT_FEATURES.md).

---

## 🤝 Contribute

Dependency-light (zero runtime deps in the hot hook path; `@modelcontextprotocol/sdk` loaded dynamically; `js-tiktoken` optional peer for accurate `analyze`). Test-first.

```bash
git clone https://github.com/RahulDhiman93/Tokenomy && cd Tokenomy
npm install && npm run build
npm test             # all green
npm run coverage     # c8 → coverage/lcov.info + HTML
npm run typecheck    # tsc --noEmit
npm link             # point `tokenomy` at your local build
tokenomy doctor
```

**Guiding principles.** (1) Fail-open always — broken hook worse than no hook; never exit 2. (2) Schema invariants over trust — outputs never fabricate keys, flip types, shrink arrays. (3) Path-match over markers — uninstall identifies entries by absolute command path. (4) Measure before bragging — no "X % savings" claims without Phase 2 benchmark data. (5) Small + legible — a dozen lines aren't worth a 200 KB install.

**Before opening a PR.** `npm test` green. Touched a rule → add passthrough *and* trim tests. Touched `init`/`uninstall` → extend the round-trip integration test. Added a config field → document it in [docs/features/configure.md](./docs/features/configure.md).

---

## 📜 License

MIT — see [LICENSE](./LICENSE).

<div align="center">

<img alt="Tokenomy mark" src="https://raw.githubusercontent.com/RahulDhiman93/Tokenomy/main/src/assets/logo.jpg" width="56">

*Save tokens. Save money.*

</div>
