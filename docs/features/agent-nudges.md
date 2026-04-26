# Agent nudges

Redirect waste before it happens. Nudges cost nothing if the agent was going to do the right thing anyway — and save 10–50k tokens per occurrence when it wasn't.

## OSS-alternatives Write nudge (alpha.18+)

When Claude is about to create a new file in a utility-ish path (`src/utils/**`, `src/lib/**`, `pkg/**`, `internal/**`, etc.) above 500 B, Tokenomy appends `additionalContext` recommending `mcp__tokenomy-graph__find_oss_alternatives` first. The agent checks this repo + local branches + npm / PyPI / pkg.go.dev / Maven Central before writing anything.

The Write input is unchanged; Tokenomy never blocks the file write.

Disable: `tokenomy config set nudge.write_intercept.enabled false`.

## Prompt-classifier nudge (alpha.22+)

Fires once per user turn, **before** Claude plans. Classifies intent and points at the right graph tool:

| Intent | Trigger | Suggested tool |
|---|---|---|
| `build` | Library/package-search framing only — "any existing library for X", "alternative to Y", "off-the-shelf Z", "instead of building", "reinventing the wheel" *(beta.6+: was `build\|implement\|add\|create\|make\|write` — too broad, fired on every coding turn)* | `find_oss_alternatives` |
| `change` | `refactor\|rename\|migrate\|extract\|replace` | `find_usages` + `get_impact_radius` |
| `remove` | `remove\|delete\|drop\|deprecate\|prune` | `get_impact_radius` |
| `review` | `review\|audit\|blast radius\|what changed` | `get_review_context` |

Conservative gates: skips prompts under 20 chars, skips when the prompt already mentions a graph tool, graph-dependent intents only fire when a graph snapshot exists for the repo.

Per-intent toggles via `nudge.prompt_classifier.intents.{build,change,remove,review}`. Disable entirely: `tokenomy config set nudge.prompt_classifier.enabled false`.

## Repo-search relevance gate (beta.6+)

When the OSS-alt query has ≥ 3 distinct tokens, `find_oss_alternatives` requires at least 2 token hits per file before returning a repo match. Multi-word descriptions like "rate limiter backoff" no longer surface random `main.ts` matches that hit on a single common noun.

## Privacy

Local repo/branch search stays on the machine. Registry search sends the description/keywords to public package registries — disable for proprietary descriptions: `tokenomy config set nudge.write_intercept.enabled false` (turns off the proactive trigger; the MCP tool is still there if you call it explicitly).
