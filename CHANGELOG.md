# Changelog

All notable changes to **Tokenomy** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) starting at `1.0.0`. Pre-`1.0.0` releases are alpha and may break on minor bumps.

## [Unreleased]

## [0.1.0-alpha.4] — 2026-04-17

### Changed
- Publish workflow simplified: release-triggered publishes always use `--tag latest`. The previous approach (publish to `alpha`, then a separate `npm dist-tag add … latest` step) fails because npm's OIDC trusted publishing only covers the `publish` command, not `dist-tag` mutations. During the alpha phase, `latest` == newest is the right semantic anyway — the `-alpha.N` suffix in the version string is the only pre-release signal users need. When stable 1.0 ships, we'll revisit split tags.
- Manual `workflow_dispatch` runs still respect the user's explicit tag choice (useful for canary beta/rc publishes without moving `latest`).

## [0.1.0-alpha.3] — 2026-04-17

### Added
- `publish.yml` now auto-updates the `latest` dist-tag to the newest release after a successful publish. `npm install tokenomy` (no tag) always pulls the most recent version; the npm badge and npmjs.com landing page stay current without manual `npm dist-tag add` + OTP.

## [0.1.0-alpha.2] — 2026-04-17

### Added
- Dual-publish to GitHub Packages (`@rahuldhiman93/tokenomy`) in the `publish.yml` workflow, alongside the primary npmjs.com publish. Populates the repo's "Packages" sidebar on GitHub.

### Changed
- README prioritizes `npm install -g tokenomy@alpha` over the local clone-build-link flow. The Development section now clearly frames source installs as the bleeding-edge / contributor path, not the default.

## [0.1.0-alpha.1] — 2026-04-17

First release cut via the new `publish.yml` workflow. End-to-end verification of the OIDC trusted-publishing flow + provenance attestation.

### Added

- CONTRIBUTING.md with pick-a-task guide, local dev loop, code conventions, testing philosophy, PR workflow, bug-report and code-of-conduct sections.
- `.github/pull_request_template.md` with surface checklist, test-plan block, and invariant preservation checklist.
- `CHANGELOG.md` (this file).
- GitHub Actions CI workflow running `build`, `test`, and `c8` coverage on Node 20 + 22.
- `c8` dev dependency + `npm run coverage` script (json-summary + lcov + html reporters).
- Self-hosted coverage badge via `shields.io` dynamic endpoint backed by `.github/badges/coverage.json` — no third-party account required; CI auto-commits the JSON on main pushes.
- README badges for CI status, self-hosted coverage, and npm version.
- `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml` as GitHub Issue Forms, plus `config.yml` routing architectural discussions to Discussions and security issues to email.
- `.github/workflows/publish.yml` — OIDC-based npm trusted publishing on GitHub Release (auto-infers dist-tag from pre-release suffix: `*-alpha* → alpha`, `*-beta* → beta`, `*-rc* → rc`, stable → `latest`). Manual `workflow_dispatch` supports a dry-run toggle. No npm token needed; uses `id-token: write` + `--provenance` for supply-chain attestation.
- Initial npm publish: `tokenomy@0.1.0-alpha.0` under the `@alpha` dist-tag.

## [0.1.0-alpha.0] — 2026-04-17

First public alpha. Phase 1 scope: transparent MCP tool-output trimming via `PostToolUse` + automatic `Read` input clamping via `PreToolUse`.

### Added

- **`PostToolUse` hook matcher `mcp__.*`** — trims MCP tool responses via `hookSpecificOutput.updatedMCPToolOutput`. Handles both the `CallToolResult` object shape (`{content: [...]}`) and the raw content-array shape used by Claude.ai connectors. Preserves non-text blocks in original position, head+tail trims text blocks that exceed budget, appends a single recovery-hint footer. Never shrinks `content.length`.
- **`PreToolUse` hook matcher `Read`** — when `Read` is called without explicit `limit` / `offset` and the target file exceeds `read.clamp_above_bytes`, injects `limit: read.injected_limit` and an `additionalContext` note so Claude can `offset`-Read more regions.
- **CLI** — `tokenomy init` / `doctor` / `uninstall` / `config get|set`. Idempotent install, atomic settings.json write with parent-dir fsync, timestamped backup with collision counter, path-based uninstall (no brittle marker keys).
- **`tokenomy doctor`** — 9 deterministic checks (Node ≥ 20, settings parse, both hook entries present, hook binary executable, smoke-spawn latency, config parse, log dir writable, manifest drift, overlapping `mcp__.*` warning).
- **Savings log** at `~/.tokenomy/savings.jsonl` — one JSONL row per trim with `tokens_saved_est`.
- **Debug log** at `~/.tokenomy/debug.jsonl` — one row per hook invocation (including passthroughs) for diagnosis.
- **Install manifest** at `~/.tokenomy/installed.json` — diagnostic-only; uninstall identifies hooks by command path, not manifest UUID.
- **Config** — global `~/.tokenomy/config.json` merged with per-repo `./.tokenomy.json`; aggression multiplier (`conservative` ×2 / `balanced` ×1 / `aggressive` ×0.5) scales numeric thresholds.
- **41 tests** — unit (rules, gate, config, manifest, settings-patch), integration (hook subprocess spawn, init+uninstall round-trip against tmp HOME). All pass in under one second.

### Design principles

- Fail-open always (exit 0 with empty stdout on any error; exit 2 never used).
- Schema invariants asserted by tests (no fabricated keys, no type flips, no lost `is_error`).
- Zero runtime dependencies; hook binary is Node stdlib only.
- Path-match over injected markers for uninstall stability.
- No "X% savings" claims until Phase 2 benchmarks them against a real transcript corpus.

### Out of scope (deferred to later phases)

- Trimming `Bash` / `Grep` / `Glob` output — the Claude Code hook contract restricts `updatedMCPToolOutput` to MCP tools.
- `Bash` input-bounding via `PreToolUse` — Phase 4.
- MCP companion server (`tokenomy_summarize`, etc.) portable to Codex — Phase 3.
- Statusline with live savings counter — Phase 2.
- `tokenomy analyze` over transcripts — Phase 2.

[Unreleased]: https://github.com/RahulDhiman93/Tokenomy/compare/v0.1.0-alpha.4...HEAD
[0.1.0-alpha.4]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.1
[0.1.0-alpha.0]: https://github.com/RahulDhiman93/Tokenomy/releases/tag/v0.1.0-alpha.0
