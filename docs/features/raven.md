# Raven — cross-agent handoff + review

Opt-in (beta.4+) Claude-first bridge for users who also have Codex CLI. Claude works; Codex independently reviews; Raven compares findings and gates merge readiness.

No subprocess voodoo — packets and reviews are plain JSON / markdown under `~/.tokenomy/raven/<repo>/`, and every downstream check verifies `packet.head_sha` against the current HEAD.

## Commands

```bash
tokenomy raven enable                 # opt-in; refuses unless `codex` is on PATH (override: cfg.raven.requires_codex = false)
tokenomy raven brief [--goal=<text>]  # snapshot git + graph review context + impact into a packet
tokenomy raven status                 # read-only state
tokenomy raven compare                # match findings deterministically
tokenomy raven pr-check               # no / risky / yes merge readiness verdict
tokenomy raven clean [--keep=<N>] [--older-than=<days>] [--dry-run]
tokenomy raven install-commands       # writes .claude/commands/raven-brief.md + raven-pr-check.md (never clobbers)
tokenomy raven disable
```

## Packet contents

`tokenomy raven brief` writes a packet with:

- **repo**: root, repo_id, branch, head_sha, base_ref *(0.1.2+)*, dirty
- **git**: staged_files, unstaged_files, untracked_files, committed_files *(0.1.2+)*, changed_files (union), stats, diff_summary, dropped_files, diff_truncated
- **graph** (when enabled): review_context + impact_radius for changed files
- **session** (when enabled): estimated_tokens + recent_tools
- **risks**, **review_focus**, **open_questions**

Diffs are ranked by hotspot score with per-file + total byte budgets enforced — hot-path files win.

## base_ref + committed_files (0.1.2+)

Earlier behavior left `changed_files` empty when the working tree was clean — packets created on a feature branch with all changes already committed had nothing for reviewers to read. Raven now resolves a base ref:

1. `RAVEN_BASE_REF` env
2. `origin/HEAD` symref
3. `origin/main`, `origin/master`, `main`, `master`

Commits unique to HEAD relative to the base land in `git.committed_files`, get included in `git.changed_files`, and feed `git.diff_summary`.

## Comparison rules

Deterministic matcher — no LLM in the loop:

- File + line + severity must match exactly
- Title bigram-Dice ≥ 0.85

Outputs: agreements, disagreements (risky-unique high/critical only), `recommended_action: merge | fix-first | investigate`.

## PR-check verdict

| Verdict | Trigger |
|---|---|
| `no` | Any unresolved `critical` finding / stale HEAD / zero reviews |
| `risky` | Graph stale / dirty tree / high-severity disagreement |
| `yes` | Otherwise |

Exit code 2 when blocking.

## MCP tools

All budget-clipped, all refuse stale packets:

- `create_handoff_packet`
- `read_handoff_packet`
- `record_agent_review`
- `list_agent_reviews`
- `compare_agent_reviews`
- `get_pr_readiness`
- `record_decision`

## Cross-repo scope (0.1.3+)

Every Raven MCP tool accepts an optional `path` arg routing the call at a specific repo. Without it, the MCP server's startup cwd is used — wrong when the agent works across multiple repos in one Claude session. Pass `path: "$PWD"` (or any absolute repo root) and Tokenomy resolves the right per-repo Raven store.

`tokenomy report` and `tokenomy analyze` scope the rolled-up Raven block to the current repo by default. Pass `--all-repos` to either CLI to restore the pre-0.1.3 global aggregate (across every registered Raven store under `~/.tokenomy/raven/`).

`tokenomy raven status` was already per-repo.

## Out-of-scope

`review --agent` auto-subprocessing (human-in-the-loop flow instead — print the packet path, run Codex in a second terminal, it calls `record_agent_review`) and `dispatch --worktree` (follow-up).
