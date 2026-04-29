# Observability + retrospection

## `~/.tokenomy/savings.jsonl`

Every trim and nudge appends a row with measured `bytes_in` / `bytes_out` and estimated tokens saved.

```bash
tail -f ~/.tokenomy/savings.jsonl
```

```jsonl
{"ts":"...","tool":"mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql","bytes_in":28520,"bytes_out":2800,"tokens_saved_est":6430,"reason":"mcp-content-trim"}
{"ts":"...","tool":"Read","bytes_in":48920,"bytes_out":15000,"tokens_saved_est":8480,"reason":"read-clamp"}
```

Quick tally:

```bash
grep -oE '"tokens_saved_est":[0-9]+' ~/.tokenomy/savings.jsonl | awk -F: '{s+=$2;n++}END{printf "trims:%d tokens:%d\n",n,s}'
```

## `tokenomy report`

Digest of `~/.tokenomy/savings.jsonl` — TUI + HTML, grouped by tool, by reason, by day. Answers "am I actually saving tokens?"

```bash
tokenomy report                          # TUI + writes ~/.tokenomy/report.html
tokenomy report --since 2026-04-01
tokenomy report --top 20
tokenomy report --json
tokenomy report --out /tmp/report.html
```

HTML adds a daily bar chart. Pricing: `tokenomy config set report.price_per_million 15`.

Surfaces Raven bridge stats (packets, reviews, comparisons, decisions, repo count, last activity) alongside trims.

## `tokenomy analyze`

Walks `~/.claude/projects/**/*.jsonl` + `~/.codex/sessions/**/*.jsonl`, replays the full pipeline over every historical tool call with a real tokenizer, and reports what Tokenomy *would have* saved.

```bash
tokenomy analyze                          # last 30d, top 10 tools
tokenomy analyze --since 7d
tokenomy analyze --project Tokenomy
tokenomy analyze --session 6689da94
tokenomy analyze --tokenizer tiktoken     # accurate cl100k counts (npm i -g js-tiktoken)
tokenomy analyze --json
tokenomy analyze --verbose                # per-day breakdown
tokenomy analyze --tune                   # writes ~/.tokenomy/golem-tune.json
```

Output: rounded-box header, per-rule savings bars, top-N waste leaderboard, duplicate hotspots, ⚠ Wasted-probe incidents (same tool, ≥ 3 distinct-arg calls within 60 s), largest individual results, by-day sparkline, Raven block.

Tokenizers: `heuristic` (default, ±10 % on code/JSON), `tiktoken` (real `cl100k_base`), `auto` (tiktoken if present).

## `tokenomy diff` (beta.3+)

Replay one historical tool call through the current rule stack and show per-rule savings breakdown.

```bash
tokenomy diff --call-key <sha>
tokenomy diff --tool <name> [--grep <str>]
tokenomy diff --session <id> --index <N>
```

Output includes a capped response preview so you can see exactly what the rule saw.

## `tokenomy learn` (beta.3+)

Mines `~/.tokenomy/savings.jsonl` and proposes config patches (new `bash.custom_verbose` entries, raise `read.injected_limit`, enable `redact.pre_tool_use`).

```bash
tokenomy learn               # read-only, prints proposed patches
tokenomy learn --apply       # writes ~/.tokenomy/config.json with timestamped backup
```

## `tokenomy budget` (beta.3+)

Advisory `PreToolUse` rule that estimates incoming-call response size from analyze cache and warns via `additionalContext` when the call would push the session past `cfg.budget.session_cap_tokens`. Never rejects. Default off.

## `tokenomy bench` (beta.2+)

Deterministic scenario runner — no live network, all inputs are captured fixtures committed to `fixtures/bench/`.

Six scenarios: `read-clamp-large-file`, `bash-verbose-git-log`, `mcp-atlassian-search`, `shell-trace-trim`, `compress-agent-memory`, `golem-output-mode`.

```bash
tokenomy bench               # run all scenarios
tokenomy bench compare <a.json> <b.json>   # per-scenario regressions
```

## `tokenomy status-line` (beta.2+)

`tokenomy init` patches `settings.json.statusLine`. Reads today's `savings.jsonl`, aggregates by tool/reason, emits a one-liner like `[Tokenomy v0.1.5 · GOLEM-GRUNT · 4.2k saved · graph fresh · Raven · Kratos]`.

Segments (left-to-right): version + `↑` if an update is available, GOLEM mode (when on), today's saved-tokens count, graph freshness, Raven badge (when enabled), Kratos badge (when continuous shield is on).

After `tokenomy update --check`, a `↑` is appended when a newer release exists on npm (e.g. `v0.1.5↑`). 0.1.3+: cache TTL is 24h and SessionStart + the statusline (every 3h) auto-spawn `tokenomy update --check --quiet` so a new release surfaces on the next Claude Code restart or within 3h on a long-running session.

Must return in < 50 ms — uses a bounded read of the log and no external I/O. Fails open: missing config or parse error → empty string → Claude Code renders nothing.

## `tokenomy doctor`

Health checks covering hook install, settings.json integrity, statusline registration, manifest drift, MCP registration, hook perf budget, agent detection.

```bash
tokenomy doctor              # all checks
tokenomy doctor --fix        # routine repair
```

`--fix` creates the log directory, `chmod +x`'s the hook binary, re-patches `~/.claude/settings.json` on manifest drift.

## `tokenomy update`

Single-command self-update.

```bash
tokenomy update              # install latest + re-stage hook
tokenomy update --check      # query registry, print installed vs remote, exit 1 if out of date
tokenomy update@0.1.5 # npm-style pin
tokenomy update --version=0.1.5
tokenomy update --tag=beta   # opt into a non-default dist-tag
```

Wraps `npm install -g tokenomy@<target>` AND re-runs `tokenomy init` — the staged hook under `~/.tokenomy/bin/dist/` is a frozen copy taken at init time, so a plain npm upgrade leaves the hook running old code.

Safety:

- Refuses to install over an `npm link`-style dev checkout (override with `--force`)
- Refuses downgrades when the resolved version is older than installed (override with `--force`)
