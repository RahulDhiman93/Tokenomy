# Tokenomy Next Features

Goal: make Tokenomy the default operating layer for local coding agents,
especially Claude Code and Codex CLI. The current core is token waste
reduction. The next layer should make agents cheaper, better oriented, and
less likely to repeat unsafe or low-signal work.

## Current Integration Reality

Claude Code is still the richest live-control target. It exposes lifecycle
hooks for prompt submission, tool calls, compaction, subagents, session start,
and session end; it also supports status line commands and MCP tools.

Codex CLI now has experimental hooks, but the current runtime is narrower.
`SessionStart` and `UserPromptSubmit` can inject developer context, while
`PreToolUse` and `PostToolUse` are currently Bash-only and do not support the
same output mutation surface Tokenomy uses for Claude MCP trimming. Codex MCP
configuration is shared between CLI and IDE extension through Codex config.

## Tier 1: Ship Next

1. **Codex hook install parity**

   Install `~/.codex/hooks.json`, enable `features.codex_hooks`, and wire
   Tokenomy's existing `SessionStart` and `UserPromptSubmit` hook behavior
   into Codex. This brings Golem and prompt-classifier nudges to Codex without
   overclaiming unsupported live output mutation.

   Status: implemented in this branch for user-scoped Codex hooks.

2. **Agent rule pack generator**

   Add `tokenomy agents install-rules --agent=<name>` to create compact,
   agent-native rules:

   - `AGENTS.md` for Codex
   - `CLAUDE.md` / `.claude/rules/*.md` for Claude Code
   - Cursor, Windsurf, Cline, and Gemini equivalents

   The generated rules should be short and deterministic: prefer Tokenomy graph
   tools before broad reads, call `find_oss_alternatives` before utility
   rewrites, keep command output bounded, and ask for full output only when
   needed.

3. **PreCompact and PostCompact memory compactor**

   Claude Code exposes compaction hooks. Add a compaction-time summary that
   preserves decisions, files changed, failing tests, and open questions, then
   drops repeated tool chatter. This complements `tokenomy compress`, which
   handles static instruction files.

4. **Python graph parser**

   Phase 6 should start with Python because Codex and Claude sessions commonly
   touch mixed TS/Python repos. Cover imports, definitions, call-ish references,
   pytest target hints, and package-root detection from `pyproject.toml`,
   `setup.cfg`, and `requirements.txt`.

5. **Workflow MCP tools**

   Add higher-level tools on top of the graph:

   - `prepare_change_plan`
   - `suggest_tests`
   - `summarize_branch`
   - `explain_failure`
   - `get_agent_brief`

   These should return task-shaped context, not raw graph dumps.

## Tier 2: Make It Sticky

6. **Token budget profiles**

   Add named modes like `cheap`, `balanced`, `deep-review`, and `incident`.
   Each mode should tune graph budgets, MCP trim levels, Bash caps, Golem mode,
   and prompt-classifier behavior together.

7. **Session ledger**

   Record a per-session artifact under `~/.tokenomy/sessions/`: prompts,
   graph tools used, repeated reads, largest outputs, savings, changed files,
   and tests run. Use it for both reports and future session-start briefs.

8. **Stop hook quality gate**

   For Claude Code, use `Stop` to inject one final continuation prompt only
   when there is strong evidence of unfinished work: changed files with no
   tests, unresolved failing commands, or TODO-style model text. Keep this
   conservative because aggressive Stop hooks can annoy users quickly.

9. **Subagent budget governor**

   Codex supports explicit subagent workflows, and Claude Code has subagent
   lifecycle hooks. Track subagent count, repeated exploration, and expensive
   duplicate work. Warn or inject context when parallel agents are about to
   rediscover the same files.

10. **Connector profile packs**

    Expand schema-aware trim profiles for Asana, HubSpot, Intercom, Datadog,
    Sentry, Stripe, Supabase, Vercel, and common GitHub issue/search shapes.
    Pair each profile with captured fixtures and `bench` scenarios.

## Tier 3: Team Product

11. **Team report export**

    Add `tokenomy report --share` to generate a redacted HTML/Markdown summary
    suitable for PRs, Slack, or internal docs: savings, hot tools, repeated
    calls, missing graph coverage, and recommended config changes.

12. **Repo onboarding score**

    Add `tokenomy doctor --score` for agent readiness: graph built, rules file
    compressed, MCP connected, tests discoverable, common huge files excluded,
    and supported language parsers enabled.

13. **CI regression guard**

    Add a GitHub Action example that runs `tokenomy bench compare` and fails
    if a PR regresses fixture savings, hook latency, or graph build time beyond
    configured thresholds.

14. **Remote MCP option**

    Keep stdio as the default, but add an optional remote MCP server mode for
    teams that want shared graph summaries, centralized profiles, or managed
    config. Treat this as an enterprise/team feature, not the default local
    workflow.

## Positioning

Tokenomy should not be "another context tool." Its sharper claim is:

> Tokenomy is the agent efficiency layer for Claude Code and Codex CLI:
> install it once, then every session starts with less waste, better repo
> orientation, safer tool use, and measurable savings.

The product line should keep a strict split:

- **Live control** where the agent exposes compatible hooks.
- **MCP retrieval** where hooks are missing or narrower.
- **Transcript analysis** for anything Tokenomy cannot intercept live yet.
- **Rule/skill/plugin packs** to make agents voluntarily use the right tools.
