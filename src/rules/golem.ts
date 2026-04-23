import type { Config } from "../core/types.js";

// Golem — the tireless-clay-worker output-mode plugin for tokenomy.
//
// Golem attacks the one token surface tokenomy's other rules leave alone:
// the assistant's own replies. Input-side trimming (MCP trim, Read clamp,
// Bash bounder) can save 100k tokens on a busy day, but a 500-token reply
// × 50 turns in a session is another 25k tokens of output that is billed
// more expensively than input on every major provider.
//
// Golem ships three modes. Each injects a concise style rule via the
// SessionStart hook; UserPromptSubmit re-injects a short reminder every
// turn so the rules survive competition from other plugins (Cursor rules,
// project CLAUDE.md, etc). Nothing is stochastic — the rule list is fixed
// and documented. Users can inspect exactly what Golem adds to the
// conversation by running `tokenomy golem status`.
//
// Safety gates: Golem never compresses fenced code blocks, shell commands,
// security/auth warnings, destructive-action language, error messages, or
// stack traces. These five classes are the ones where terseness is
// actively harmful. The gates are on by default; advanced users can
// disable via `nudge.golem.safety_gates = false` but that's rarely wise.

export type GolemMode = "lite" | "full" | "ultra" | "grunt";

// The canonical rule blocks. Kept as plain text so users who run
// `tokenomy golem status` can see exactly what's being injected — no
// stochastic template generation, no opaque prompt engineering.
const LITE_RULES = [
  "Drop hedging: no \"I think\", \"perhaps\", \"you might want to\", \"it seems\".",
  "Drop pleasantries: no \"great question\", \"happy to help\", \"absolutely\".",
  "Drop repeat caveats: state a caveat once, never twice in one reply.",
  "Skip narration of what you are about to do; just do it and report results.",
].join("\n  - ");

const FULL_RULES = [
  LITE_RULES,
  "Use declarative sentences; avoid softeners (\"perhaps\", \"maybe\", \"could\").",
  "One-sentence conclusions after tool results, not a paragraph.",
  "No restating the user's question back before answering.",
  "No \"let me know if...\" closers.",
].join("\n  - ");

const ULTRA_RULES = [
  FULL_RULES,
  "Maximum 3 non-code lines per reply unless the user asked for a plan or analysis.",
  "Single-word confirmations where accurate: \"Done.\", \"Shipped.\", \"Yes.\", \"No.\".",
  "Lists over prose whenever a list works.",
  "No headers on replies under 10 lines.",
].join("\n  - ");

// GRUNT — the tightest Golem mode. A Golem that literally grunts. Caveman-
// adjacent energy but still safety-gated: numbers, code, commands, and
// warnings are preserved verbatim. Prose around them becomes fragments.
// Use when every token counts and tone doesn't matter.
const GRUNT_RULES = [
  ULTRA_RULES,
  "Drop articles (a, an, the) wherever the meaning survives. \"Use p-retry\" beats \"Use the p-retry library\".",
  "Drop subject pronouns when context is obvious. \"Skipping.\", \"Done.\", \"Fixed it.\" — not \"I'm skipping.\".",
  "Fragments over complete sentences when intent is clear. \"Tests green. Ready to ship.\" — not \"The tests are green and the code is ready to ship.\".",
  "Questions as fragments. \"Ship?\", \"Revert?\", \"Retry?\" — not \"Should I ship this now?\".",
  "Occasional playful terseness is allowed: \"ship it.\", \"nope.\", \"aye.\", \"bah.\", \"done and done.\". Keep it dry; no emoji, no exclamation.",
  "Never sacrifice a number, name, path, or warning for brevity. Those stay verbatim.",
].join("\n  - ");

const SAFETY_GATES = `
ALWAYS PRESERVE IN FULL (these override every rule above):
  - Fenced code blocks and inline code spans
  - Shell commands and CLI snippets
  - Security/auth warnings (anything mentioning auth, secret, token, credential, API key)
  - Destructive-action language (rm -rf, DROP TABLE, git push --force, reset --hard, production deploys, migrations)
  - Error messages, stack traces, file paths, URLs
  - Numerical results, counts, measurements (precision matters)
`.trim();

const rulesFor = (mode: GolemMode): string => {
  if (mode === "lite") return LITE_RULES;
  if (mode === "ultra") return ULTRA_RULES;
  if (mode === "grunt") return GRUNT_RULES;
  return FULL_RULES;
};

const modeLabel = (mode: GolemMode): string => mode.toUpperCase();

// Session-start preamble: full style rules + safety gates. Loaded once per
// session so the agent has the full rule set in working memory from turn 1.
export const buildGolemSessionContext = (cfg: Config): string | null => {
  const g = cfg.golem;
  if (!g || !g.enabled) return null;
  const rules = rulesFor(g.mode);
  const gates = g.safety_gates ? `\n\n${SAFETY_GATES}` : "";
  return (
    `[tokenomy-golem: ${modeLabel(g.mode)} mode — terse assistant replies, deterministic rules]\n\n` +
    `Apply these output-style rules to every assistant reply in this session:\n` +
    `  - ${rules}${gates}\n\n` +
    `Turn Golem off: \`tokenomy golem disable\`. Change mode: ` +
    `\`tokenomy golem enable --mode lite|full|ultra\`.`
  );
};

// Per-turn reinforcement: very short (~30 tokens) reminder that Golem is
// active. This is a tax against plugin drift — without it, other hooks or
// project rules that fire AFTER SessionStart can shadow the Golem rules.
// Intentionally short so the per-turn overhead stays under 1% of a typical
// assistant reply budget.
export const buildGolemTurnReminder = (cfg: Config): string | null => {
  const g = cfg.golem;
  if (!g || !g.enabled) return null;
  return `[tokenomy-golem: ${modeLabel(g.mode)} — terse replies, preserve code/commands/warnings verbatim]`;
};

// Rough per-turn output-token savings estimate, used for savings.jsonl and
// `tokenomy report`. These are back-of-the-envelope numbers derived from
// caveman's benchmark range (22–87% reduction, they report ~65% average);
// we pick conservative values to avoid overclaiming. Users who want real
// numbers should run `tokenomy analyze` which replays transcripts against
// a real tokenizer.
export const estimateGolemSavingsTokens = (mode: GolemMode): number => {
  if (mode === "lite") return 150; // per-turn estimate — gentle drops
  if (mode === "ultra") return 500; // aggressive terseness
  if (mode === "grunt") return 750; // tightest — articles + pronouns dropped too
  return 300; // full-mode default
};
