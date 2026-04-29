# `tokenomy diagnose` (0.1.5+)

Single-command JSON health report. Read-only. Designed for users to copy + paste into `tokenomy feedback` when reporting an issue.

## Usage

```bash
tokenomy diagnose            # human header + full JSON body
tokenomy diagnose --json     # machine-readable JSON only
```

Exits 1 only when `tokenomy doctor` reports a hard failure. Section-level `ok: false` flags surface as `worst: "warning"` and exit 0.

## What's covered

| Section | Contents |
|---|---|
| `tokenomy` | version, bin path, home dir |
| `env` | platform, os release, node version, arch, cwd, home |
| `agents` | each of `claude` / `codex` / `cursor` / `windsurf` / `cline` / `gemini` with `on_path` boolean |
| `doctor` | `total`, `failed`, `failed_names` (delegates to `runDoctor`) |
| `graph` | repo_id, repo_path, meta + snapshot presence, dirty sentinel + rebuild lock state, snapshot bytes, age, built_at |
| `raven` | root path, repo count, total bytes |
| `kratos` | enabled, continuous, prompt_min_severity, per-category toggles |
| `golem` | enabled, mode, safety_gates |
| `update` | cache present, age, bytes, stale flag (> 24h) |
| `feedback_log` | path + bytes if `~/.tokenomy/feedback.jsonl` exists |
| `config` | log_path, every feature's enabled flag |
| `worst` | rolled up: `ok` / `warning` / `error` |

## Privacy

Same as `tokenomy feedback`: no transcripts, no `savings.jsonl` content, no config secrets. The output names paths but not their contents.

## When to run

- Before opening a GitHub issue: `tokenomy diagnose --json | pbcopy` (macOS) then paste into `tokenomy feedback "..."`.
- In CI smoke tests: assert `worst != "error"`.
- When the statusline / hook behaves unexpectedly: the `graph.dirty_sentinel_present` + `update.stale` flags surface common drift conditions.
