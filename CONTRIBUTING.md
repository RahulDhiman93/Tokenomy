# Contributing to Tokenomy

Thanks for wanting to make coding agents (Claude Code, Codex CLI) lighter on tokens. Tokenomy is small by design (zero runtime deps in the hot path) — which means almost any contribution lands in shippable scope within a day.

This document goes deeper than the README's "Contribute" section: setup, conventions, testing philosophy, and the PR process.

---

## TL;DR checklist

Before you open a PR, make sure:

- [ ] `npm test` is green (existing 161+ tests pass)
- [ ] New rule? Add at least one passthrough and one trim test case
- [ ] Touched `init`/`uninstall`? Extend the round-trip integration test
- [ ] New config field? Document it in `README.md` and `DEFAULT_CONFIG`
- [ ] Breaking change to settings.json layout, manifest format, or public CLI? Flag it in the PR body under **Breaking changes**

---

## Picking something to work on

### If you've never contributed before

Start with one of these — each is self-contained and ≤ 1 day:

| What | Why it's a good first PR | Entry point |
|---|---|---|
| A synthetic fixture for an MCP tool you actually use (HubSpot, Asana, Notion) + a rule-level test | Grows the test corpus Phase 2 will lean on; teaches the codebase in one file | `tests/unit/mcp-content.test.ts` |
| README clarification, typo, broken link | Easiest way to learn the review loop | `README.md` |
| New config knob with sensible default + unit test for the multiplier | Small, well-scoped; touches `core/config.ts` + `core/types.ts` only | `src/core/config.ts` |

### If you've shipped a PR or two

Pick a row from the **Good first issues** table in the README. The 🟡 medium / 🔴 hard rows map directly to Phase 2–4 milestones. Comment on (or open) an issue first so we can align on approach before you invest time.

### Proposing a new phase / surface

Open a GitHub Discussion (not a PR) with:
- What behavior changes the agent sees (Claude Code, Codex, or both)
- Which hook event or agent mechanism is used
- What can *go wrong* and how the fail-open guarantee is preserved

Architecture changes get reviewed the same way v1 of the plan did — cross-checked against primary docs before any code lands.

---

## Local development

### Setup

```bash
git clone <repo> && cd tokenomy
npm install
npm run build
npm link          # puts `tokenomy` on PATH; reverse with `npm unlink -g tokenomy`
```

Node 20+ required (we use `node:test`, `cpSync`, fsync on directories).

### Everyday loop

```bash
# write code
npm test                         # ~2 s unit + integration
npm run build                    # re-emit dist/
tokenomy doctor                  # 12/12 ✓ if things are wired
tail -f ~/.tokenomy/debug.jsonl  # see every hook invocation in your live session
tokenomy analyze --since 1d      # sanity-check changes against real transcripts
```

### End-to-end smoke

```bash
rm -rf /tmp/tokenomy-smoke && mkdir -p /tmp/tokenomy-smoke/.claude
echo '{"model":"opus[1m]"}' > /tmp/tokenomy-smoke/.claude/settings.json
HOME=/tmp/tokenomy-smoke tokenomy init
HOME=/tmp/tokenomy-smoke tokenomy doctor
```

This exercises `init` against a clean HOME without touching your real `~/.claude/`.

### Debugging the live hook

If Claude Code ever misbehaves, first look at `~/.tokenomy/debug.jsonl` — every hook invocation appends a row (including passthroughs). Then check `~/.claude/debug/latest` for Claude Code's own debug log.

---

## Code conventions

Tokenomy is TypeScript + Node ESM + `node:test`. No build magic.

### Style

- **Arrow function exports.** `export const foo = () => …` — never `export function`. Matches the rest of the codebase.
- **Strict mode** is on (`noUncheckedIndexedAccess`, `strict: true`). Fix the type error; don't `any`-cast it.
- **No runtime dependencies.** Dev deps are fine (`tsx`, `typescript`, `@types/node`), but the shipped `dist/` must stay stdlib-only. The hook runs on every MCP tool call; a 200 KB `require` chain is a tax you don't want.
- **No comments unless the *why* is non-obvious.** Well-named identifiers explain the *what*.
- **No emojis in code or docstrings.** README is fine; source isn't.

### File layout

```
src/
  core/     — types, config, paths, gate, log, dedup, recovery hint
  rules/    — pure transforms: mcp-content, read-bound, text-trim, profiles, stacktrace, redact
  hook/     — entry.ts + dispatch.ts + pre-dispatch.ts (stdin → rule → stdout, Claude Code)
  analyze/  — transcript scanner (Claude Code + Codex), parse, tokens, simulate, report, render
  graph/    — code-graph schema, build, query (minimal, impact, review, usages)
  mcp/      — stdio server, tool handlers, schemas, query LRU cache, budget-clip
  parsers/  — TS/JS AST extraction
  cli/      — init, doctor (+ --fix), uninstall, config-cmd, report, analyze, graph, entry
  util/     — settings-patch, manifest, atomic-write, backup, json helpers

tests/
  unit/         — one file per module
  integration/  — spawn compiled binary; tmp HOME round-trips
  fixtures/     — JSON inputs/expected outputs, synthetic graph repo
```

Rules are pure functions. Adding a new rule is a single-file drop-in + a test file. No framework to learn.

### Guiding principles (non-negotiable)

1. **Fail-open always.** A broken hook is worse than no hook. Never exit 2, never throw past the top-level `try`, never leave stdout with garbage that breaks the agent's `JSON.parse`. When in doubt, exit 0 with empty stdout.
2. **Schema invariants over trust.** Test that rule outputs never fabricate keys, flip types, shrink arrays, or lose `is_error`. Every rule PR must add at least one invariant assertion.
3. **Path-match over markers.** Uninstall identifies our hook entries by absolute command path under `~/.tokenomy/bin/`, not by injected `_tokenomy: true` keys. The upstream settings schema may tighten tomorrow.
4. **Measure before bragging.** Use `tokenomy analyze` to back up performance claims with real transcript data instead of pulling numbers out of thin air.
5. **Small and legible.** If a dependency shaves a dozen lines for a 200 KB install cost, say no.
6. **Agent-agnostic where possible.** Live hooks are Claude-Code-specific today, but graph + analyze must work across agents. Don't bake Claude-Code-only assumptions into the shared modules.

---

## Testing philosophy

The whole test suite runs in under one second. Keep it that way.

### What to test

- **Rules.** At minimum: one passthrough case + one trim case per rule. Bonus points: mixed-type content arrays, empty content, oversized single blocks, unknown top-level keys.
- **Config.** Merge precedence (project > global), aggression multipliers, malformed JSON → defaults.
- **Util.** Settings-patch must be idempotent. Manifest round-trips must be stable. Atomic write must produce the final file even if the process is killed mid-rename (spot-check with a `kill -9` in a tight loop).
- **Integration.** Spawn the compiled `dist/hook/entry.js` as a subprocess, pipe your fixture, assert the stdout shape and exit code. Malformed stdin must never exit 2.

### Writing a new rule test

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { myRule } from "../../src/rules/my-rule.js";
import type { Config } from "../../src/core/types.js";

const CFG: Config = { /* minimum viable config for your rule */ };

test("myRule: passthrough when X", () => {
  const r = myRule(toolName, toolInput, toolResponse, CFG);
  assert.equal(r.kind, "passthrough");
});

test("myRule: trims when Y, preserves invariant Z", () => {
  const r = myRule(/* ... */);
  assert.equal(r.kind, "trim");
  if (r.kind !== "trim") return;
  // invariants — these are the ones that prevent regressions
  assert.ok(r.output.content.length >= toolResponse.content.length);
  assert.equal(r.output.is_error, toolResponse.is_error);
});
```

### Running only your test

```bash
node --import tsx --test tests/unit/my-rule.test.ts
```

---

## Commit & PR workflow

### Commits

- Short imperative subject: `feat(rules): add json-aware trim for stringified payloads`
- Prefix optional but encouraged: `feat(scope): …`, `fix(scope): …`, `test: …`, `docs: …`, `chore: …`
- One logical change per commit. Squash if the branch has noise.

### Opening the PR

Use the PR template in `.github/pull_request_template.md`. It asks for:

- **What + why** — what behavior changes, what problem it solves
- **Surface** — which Tokenomy phase / which hook event / which rule
- **Test plan** — how you verified, including the command you ran
- **Breaking changes** — any schema, config, or CLI-contract impact
- **Screenshots / logs** — for UX changes (terminal output, savings-log rows)

Title format: `<type>(<scope>): <description>`.
Examples:
- `feat(rules): add bash input-bounder for verbose commands`
- `fix(init): quote paths with spaces in settings.json command field`
- `docs(readme): clarify passthrough semantics for unknown MCP shapes`

### Review

Reviews prioritize three things, in order:

1. **Correctness of the hook contract.** Does the output match Anthropic's documented schema for that event? Does it handle `is_error`? Does it fail-open on malformed input?
2. **Invariants preserved.** Are there tests proving the rule doesn't fabricate keys / flip types / shrink arrays?
3. **Scope discipline.** Does the PR do one thing? Unrelated cleanups go in their own PR.

Stylistic notes are last, not first.

---

## Cutting a release

Maintainer-only. For now only `@RahulDhiman93` has publish rights on npmjs.com.

The publish flow is fully automated via `.github/workflows/publish.yml` using **npm trusted publishing (OIDC)** — no long-lived `NPM_TOKEN` secret is stored in the repo. Each publish exchanges a short-lived GitHub OIDC token for a one-shot npm publish credential, scoped to this package only.

### Every release

1. Branch off `main`, bump `package.json` version (e.g. `0.1.0-alpha.N` → `0.1.0-alpha.(N+1)`).
2. Add a CHANGELOG section for the new version, listing Added / Changed / Fixed items.
3. `npm run prepublishOnly` — clean + build + test + typecheck must be green.
4. Commit with `chore(release): X.Y.Z — <one-line summary>`.
5. Tag: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
6. Push main + tag. Open a PR if you branched; otherwise skip straight to (7).
7. Create a GitHub Release at https://github.com/RahulDhiman93/Tokenomy/releases/new — select the new tag, title = version, ✓ pre-release, Publish.

### What the workflow does

Two jobs run sequentially on `release: published`:

| Job | Registry | How it auths |
|---|---|---|
| `publish` | **npmjs.com** (`tokenomy`) | OIDC trusted publishing + `--provenance` |
| `publish-gpr` | **GitHub Packages** (`@rahuldhiman93/tokenomy`) | Workflow-scoped `GITHUB_TOKEN` |

Both jobs also run the full pre-publish gate inside the workflow (clean + build + test + typecheck) so what ships matches what was tested.

### Dist-tag strategy

During the alpha phase, **all release-triggered publishes go to `--tag latest`**. This keeps `npm install tokenomy` (no tag) current and the npm badge fresh. Manual `workflow_dispatch` runs honour the user-picked tag (`alpha` / `beta` / `rc` / `latest`) — useful for canary builds.

When `1.0.0` ships, this will split: stable releases go to `latest`, pre-releases go to their respective `alpha` / `beta` / `rc` tags.

### If the workflow fails

- **`ENEEDAUTH`** during publish → trusted publishing config mismatch. Check https://www.npmjs.com/package/tokenomy/access → Trusted Publishers → the workflow filename must read exactly `publish.yml` and the repo name is case-sensitive.
- **`Cannot find module 'promise-retry'`** → npm self-upgrade bug. The workflow uses `npx -y npm@11` to side-step it; if this error returns, confirm the step hasn't been rewritten to `npm install -g npm@latest`.
- **`version already published`** → the tag points at a commit where `package.json` still has a previously-shipped version. Delete the release (keep the tag for history), bump the version in a new commit, retag, re-release.

### Manual republishes

If you need to rerun without changing code, use the Actions tab → **Publish** → **Run workflow**, optionally toggling **dry run** to verify end-to-end without shipping. The workflow's "version already published" check is the safety net against accidental double-publishes.

---

## Reporting bugs

Open a GitHub Issue with:

- Your Tokenomy version (`tokenomy --version`)
- Node version (`node --version`)
- Relevant rows from `~/.tokenomy/debug.jsonl` (scrub any content you don't want public)
- `tokenomy doctor` output
- Expected vs actual behavior

Security-sensitive issues (e.g. a way to get the hook to execute arbitrary code via crafted `tool_response`): email the maintainer directly, don't open a public issue.

---

## Code of conduct

Be excellent to each other. Criticize code, not people. Assume good faith. If you hit friction, DM a maintainer instead of escalating publicly.

---

## License

By contributing, you agree your contribution is licensed under the project's [MIT License](./LICENSE).
