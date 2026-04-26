# Live token trimming

Automatic response shrinking the moment a tool call finishes (or is about to fire). Runs entirely as Claude Code hooks. Zero config to get started.

| Surface | Mechanism | Kills |
|---|---|---|
| `PostToolUse` on `mcp__.*` | `updatedMCPToolOutput`: dedup → redact → stacktrace collapse → schema-aware profile → shape-trim → byte-trim | 10–50 KB MCP responses (Atlassian, Notion, Gmail, Asana, HubSpot, Intercom…) |
| `PostToolUse` on `Bash` | stacktrace frame compressor | Deep Jest/Pytest/Java/Rust/Go failure traces |
| `PreToolUse` on `Read` | `updatedInput` injects `limit: N` | Unbounded reads on huge source files |
| `PreToolUse` on `Bash` | rewrites command to `set -o pipefail; <cmd> \| awk 'NR<=N'` | Verbose unbounded shells (`git log`, `find`, `ls -R`, `ps aux`, `docker logs`, `journalctl`, `kubectl logs`, `tree`) |
| `PreToolUse` on `Bash`/`Write`/`Edit` | secret redact in inputs | AWS/GitHub/OpenAI/Slack/Stripe keys, JWTs, Bearer tokens, PEM blocks in tool inputs |

## MCP pipeline (PostToolUse)

Stage order:

1. **Caller opt-out.** `tool_input._tokenomy === "full"` → passthrough.
2. **Duplicate dedup.** Same `(tool, canonicalized-args)` seen earlier in-session within `cfg.dedup.window_seconds` → pointer stub.
3. **Secret redactor.** Regex sweep for AWS/GitHub/OpenAI/Anthropic/Slack/Stripe/Google keys, JWTs, Bearer tokens, PEM blocks → `[tokenomy: redacted <kind>]`. Force-applies regardless of gate.
4. **Stacktrace collapser.** Node/Python/Java/Ruby — keeps header + first + last 3 frames.
5. **Schema-aware profiles.** Curated key-set per profile; built-ins for Atlassian Jira/Confluence, Linear, Slack, Gmail, GitHub. Custom profiles supported.
6. **Shape-aware trim.** Detects homogeneous row arrays (top-level or wrapped in `{transitions|issues|values|results|data|entries|records: [...]}`) and compacts per-row.
7. **Byte-trim fallback.** Head+tail with `[tokenomy: elided N bytes]` footer.

Invariants: `content.length` never shrinks, `is_error` flows through, non-text blocks pass untouched.

## Read clamp (PreToolUse)

Explicit `limit`/`offset` → passthrough. Self-contained docs (`.md/.mdx/.rst/.txt/.adoc` under `doc_passthrough_max_bytes`) → passthrough unclamped. Otherwise stat; over threshold → inject `limit: N` + an `additionalContext` note so the agent can offset-Read further regions.

## Bash input-bounder (PreToolUse)

Detects unbounded verbose invocations and rewrites to `set -o pipefail; <cmd> | awk 'NR<=200'`. Awk consumes producer output (no SIGPIPE); `pipefail` preserves exit codes.

Excludes: exit-status-sensitive commands (`git diff --exit-code`, `npm ls`, `git status --porcelain`), streaming forms (`-f`/`--follow`/`watch`/`top`), destructive `find` actions (`-exec`, `-delete`), user pipelines, redirections, compound commands (`;`/`&&`/`||`), subshells, heredocs.

`head_limit` validated as integer in `[20, 10_000]` before interpolation — no command injection.

## Bash stacktrace compressor (PostToolUse, beta.2+)

Detects Node, Python, Java, Rust, Go stack frames in `Bash` output. Preserves the assertion/error message, test names, diffs, summaries, first 3 frames, last 2 frames. Only fires when the trace has ≥ 6 frames and the saved bytes pass the global trim gate (`gate.min_saved_bytes`, default 4000). Short or already-readable failures pass through.

## Pre-call redact (beta.3+)

Extends secret redaction to `PreToolUse` on `Bash`/`Write`/`Edit`. Bash header/URL secrets are redacted and warned; bare-arg secrets are warn-only. Multi-line headers (`\`-continued) handled. Opt-in via `cfg.redact.pre_tool_use: true`.

## Fail-open

Malformed stdin / parse errors / unknown shapes → exit 0 with empty stdout. 10 MB stdin cap. 2.5 s internal timeout. Exit code 2 (blocking) never used.
