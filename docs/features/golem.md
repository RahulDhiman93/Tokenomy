# Golem — terse output mode

Opt-in plugin (beta.1+) that injects deterministic style rules at `SessionStart` and reinforces per-turn. Targets the one token surface other features leave alone — assistant output, which costs 5× input on Sonnet.

## Modes

| Mode | Style |
|---|---|
| `lite` | Drop hedging — no "I think", "perhaps", "you might want to" |
| `full` | + declarative sentences, no softeners ("perhaps", "maybe", "could") |
| `ultra` | + max 3 non-code lines per reply, single-word confirmations ("Done.", "Shipped.") |
| `grunt` | + fragments over sentences, dropped articles/pronouns, occasional "ship it." / "nope." / "aye." — caveman-adjacent energy |
| `recon` | + zero banter, info-density only. **0.1.5+ tightened to RECON v2:** 1 non-code line cap, bare `yes` / `no` (no period), no transitions, mandatory tables for ≥ 2 rows of any shape, never repeats the user's words. |
| `auto` | Resolved at SessionStart from `~/.tokenomy/golem-tune.json` (written by `tokenomy analyze --tune`). Falls back to `full` |

## Safety gates

Always preserved verbatim regardless of mode:

- Fenced code blocks and inline code spans
- Shell commands and CLI snippets
- Security/auth warnings (anything mentioning auth, secret, token, credential, API key)
- Destructive-action language (`rm -rf`, `DROP TABLE`, `git push --force`, `reset --hard`, production deploys, migrations)
- Error messages, stack traces, file paths, URLs
- Numerical results, counts, measurements

## Commands

```bash
tokenomy golem enable --mode=grunt    # enable + pick mode
tokenomy golem enable --mode=full     # tune down
tokenomy golem disable                # turn off
tokenomy golem status                 # show current mode
```

## Auto-tune (beta.3+)

`cfg.golem.mode = "auto"` reads `~/.tokenomy/golem-tune.json` and picks a mode from your real reply-size p95.

Thresholds: `< 800 B → lite`, `< 2 KB → full`, `< 5 KB → ultra`, `≥ 5 KB → grunt`.

Generate the tune file: `tokenomy analyze --tune`.
