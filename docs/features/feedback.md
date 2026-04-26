# `tokenomy feedback` (beta.6+)

Backend-less feedback channel. No service to operate, no auth to manage, no telemetry beyond what you typed plus a small env block you can review.

## Usage

```bash
tokenomy feedback "raven brief hangs on commit messages with emoji"
tokenomy feedback "kratos scan flags my proxy MCP — false positive on api.internal/mcp"
tokenomy feedback --print-only "feedback text"   # always print URL, never auto-submit / open browser
```

## What happens

1. **Local copy first.** Every submission is appended to `~/.tokenomy/feedback.jsonl` immediately. You always have a record.
2. **`gh` CLI when available.** If `gh` is on PATH and authed, files an issue under your GitHub account at `RahulDhiman93/Tokenomy` with the `feedback` label.
3. **Browser fallback otherwise.** Opens `https://github.com/RahulDhiman93/Tokenomy/issues/new?title=…&body=…&labels=feedback` in your default browser. Review and click Submit.
4. **Print-only fallback.** If neither path works (headless / no display / `--print-only`), prints the URL so you can copy + paste manually.

## What gets sent

The body of every submission is your text plus this env block:

```
tokenomy:  0.1.1-beta.6
node:      v20.x.x
platform:  darwin arm64
agents:    claude-code, codex, cursor
```

That's it. No transcripts, no `savings.jsonl`, no config dumps. If you want a richer report, paste `tokenomy doctor` output into the message yourself.

## Local log shape

`~/.tokenomy/feedback.jsonl` is append-only NDJSON:

```jsonl
{"ts":"2026-04-26T12:34:56Z","text":"raven brief hangs ...","title":"feedback: raven brief hangs …","submitted_via":"gh:https://github.com/RahulDhiman93/Tokenomy/issues/42"}
```

`submitted_via`:

- `pending` — first append, before the issue was filed
- `gh:<issue-url>` — `gh issue create` returned this URL
- `browser` — opened a prefilled URL or printed it

If your first attempt failed (offline, browser cancelled), you can always pipe the local log into `gh` later:

```bash
jq -r 'select(.submitted_via=="browser") | .text' ~/.tokenomy/feedback.jsonl \
  | gh issue create --repo RahulDhiman93/Tokenomy --label feedback --title "feedback batch" --body-file -
```
