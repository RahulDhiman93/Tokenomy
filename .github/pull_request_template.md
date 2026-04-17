<!--
Thanks for contributing to Tokenomy! Fill in the sections below and delete
any that genuinely don't apply. Keep the PR focused — one logical change per PR.
-->

## Summary

<!-- What changed and why. 1–3 sentences. Focus on behavior, not implementation. -->

## Surface

<!-- Which part of Tokenomy does this touch? Check all that apply. -->

- [ ] `PostToolUse` hook (MCP trim) — `src/rules/mcp-content.ts` / `src/hook/dispatch.ts`
- [ ] `PreToolUse` hook (Read clamp) — `src/rules/read-bound.ts` / `src/hook/pre-dispatch.ts`
- [ ] CLI — `src/cli/*`
- [ ] Config / types — `src/core/*`
- [ ] Install / settings-patch — `src/util/*`, `src/cli/init.ts`
- [ ] Tests only
- [ ] Docs / README / CONTRIBUTING
- [ ] CI / tooling
- [ ] Other (explain below)

## Why

<!--
The motivation. Examples:
- "Atlassian responses can come as a raw array, not {content:[...]} — passthrough bug in rule."
- "Users asked for a per-repo override that lowers read.clamp_above_bytes for monorepos with huge files."
-->

## How it works

<!--
A short walk-through of the change. For rules, show the before/after behavior on a
representative input. For init/uninstall, show the before/after settings.json shape.
-->

## Test plan

<!-- Markdown checklist of the checks you ran. Include exact commands. -->

- [ ] `npm test` green (report the test count: was / now)
- [ ] `npm run build` clean
- [ ] If touching rules: added at least one passthrough test + one trim test
- [ ] If touching init/uninstall: extended round-trip integration test
- [ ] End-to-end smoke against a tmp HOME:
  ```bash
  rm -rf /tmp/tok-smoke && mkdir -p /tmp/tok-smoke/.claude
  echo '{}' > /tmp/tok-smoke/.claude/settings.json
  HOME=/tmp/tok-smoke tokenomy init && HOME=/tmp/tok-smoke tokenomy doctor
  ```
- [ ] `tokenomy doctor` still 9/9 ✓ after install

## Invariants preserved

<!-- For rule changes, confirm these aren't violated. Delete lines that don't apply. -->

- [ ] Rule output never shrinks `content.length`
- [ ] Non-text MCP blocks (image, resource) keep their relative position
- [ ] Unknown top-level keys (`is_error`, etc.) flow through untouched
- [ ] Malformed stdin → exit 0 with empty stdout (fail-open)
- [ ] Exit code 2 is not used anywhere
- [ ] `Read` clamp preserves `file_path` and any other caller-supplied input keys

## Breaking changes

<!--
Flag any change to:
- ~/.claude/settings.json shape Tokenomy writes
- ~/.tokenomy/config.json schema
- ~/.tokenomy/savings.jsonl or debug.jsonl row shape
- ~/.tokenomy/installed.json manifest format
- Public CLI flags / subcommands
- Hook binary stdout JSON shape
-->

- [ ] No breaking changes
- [ ] Breaking change (describe migration path)

## Screenshots / logs

<!--
If you changed user-visible output (CLI, hook response, savings log), paste a sample.
-->

```
<paste here>
```

## Checklist

- [ ] Title follows `<type>(<scope>): <description>` (e.g. `feat(rules): add json-aware trim`)
- [ ] Rebased on `main`, no merge commits
- [ ] One logical change per PR (split unrelated cleanups)
- [ ] README / CONTRIBUTING / CHANGELOG updated if the change is user-visible
- [ ] `npm test` + `npm run build` green locally

<!--
By submitting this PR you agree your contribution is licensed under the project's MIT License.
-->
