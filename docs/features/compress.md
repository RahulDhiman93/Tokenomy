# `tokenomy compress` — agent instruction file cleanup

Deterministic cleanup for agent rule files: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.windsurf/rules`. Loaded every session, so bloat is paid every session.

## Commands

```bash
tokenomy compress status                                # show candidates + estimated savings
tokenomy compress CLAUDE.md --diff                      # preview the cleanup
tokenomy compress CLAUDE.md --in-place                  # writes a mandatory .original.md backup
tokenomy compress /path/to/CLAUDE.md --in-place --force # explicit outside-cwd override
tokenomy compress restore CLAUDE.md                     # swap the backup back
```

## What it preserves

- Frontmatter (YAML/TOML)
- Fenced code blocks (` ``` `, ` ~~~ `, indented)
- Inline code spans
- URLs
- Command examples
- Numbered/bulleted procedural steps

## What it strips

- Multi-paragraph docstrings
- Repeated boilerplate ("This document describes…")
- Tense-shift duplicates ("we should X" + "X must be done")
- Redundant headers
- Trailing whitespace + blank-line runs

## Optional local Claude rewrite

Pass `--rewrite` to additionally re-prompt the file through a local Claude run for stylistic cleanup. Off by default — strict deterministic mode is safer for agent rule files.

## Safety

`--in-place` always writes `.original.md` next to the target. `restore` swaps it back. `--force` is required when the target is outside the current cwd to prevent accidental writes to a sibling repo.
