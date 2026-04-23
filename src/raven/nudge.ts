import type { Config } from "../core/types.js";

export const buildRavenSessionContext = (cfg: Config): string | null => {
  if (!cfg.raven.enabled) return null;
  return [
    "[tokenomy-raven: Raven bridge enabled. Claude Code remains the primary agent; use Codex CLI as the second-review counterpart when available. For review, handoff, compare, or PR-readiness tasks, prefer the Raven MCP tools before broad reads: mcp__tokenomy-graph__create_handoff_packet, mcp__tokenomy-graph__read_handoff_packet, mcp__tokenomy-graph__record_agent_review, mcp__tokenomy-graph__compare_agent_reviews, mcp__tokenomy-graph__get_pr_readiness. Treat Raven packets as compact handoffs; verify claims against the diff when needed. Do not read full transcripts.]",
  ].join("\n");
};

const RAVEN_INTENT =
  /\b(review|handoff|hand off|second opinion|codex|compare|pr[- ]?check|ready to merge|merge ready|what changed|audit)\b/i;

export const buildRavenTurnReminder = (prompt: string, cfg: Config): string | null => {
  if (!cfg.raven.enabled || !cfg.raven.auto_nudge) return null;
  if (!RAVEN_INTENT.test(prompt)) return null;
  return (
    "[tokenomy-raven: Raven bridge turn. Claude Code is primary; Codex is the second-review counterpart. " +
    "Use `mcp__tokenomy-graph__create_handoff_packet` or `read_handoff_packet` first, " +
    "then record review findings with `record_agent_review` when done.]"
  );
};
