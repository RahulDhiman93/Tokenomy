import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  Config,
  PreHookInput,
  PreHookOutput,
  SavingsLogEntry,
  UserPromptHookInput,
  UserPromptHookOutput,
} from "../core/types.js";
import { readBoundRule } from "../rules/read-bound.js";
import { bashBoundRule } from "../rules/bash-bound.js";
import { writeNudgeRule } from "../rules/write-nudge.js";
import { classifyPromptRule } from "../rules/prompt-classifier.js";
import { estimateTokens } from "../core/gate.js";
import { appendSavingsLog } from "../core/log.js";
import { graphMetaPath, tokenomyGraphRootDir } from "../core/paths.js";
import { resolveRepoId } from "../graph/repo-id.js";

// Resolve tool_input.file_path against the HookInput.cwd before the rule
// calls statSync(). Claude Code may send a path relative to the user's
// prompt directory (e.g. "package-lock.json"); the spawned hook process
// doesn't inherit that cwd, so a raw statSync() on the relative string
// fails and the rule passes through, defeating the clamp. Absolute paths
// pass through unchanged.
const resolveReadPath = (input: PreHookInput): Record<string, unknown> => {
  const ti = { ...(input.tool_input ?? {}) };
  const raw = ti["file_path"];
  if (typeof raw === "string" && raw.length > 0 && !isAbsolute(raw) && input.cwd) {
    ti["file_path"] = resolve(input.cwd, raw);
  }
  return ti;
};

const graphHint = (cwd: string, cfg: Config): string | null => {
  if (!cfg.graph.enabled) return null;
  // Cheap gate before we pay for resolveRepoId (git subprocess):
  // if no graphs dir exists at all, bail without spawning git.
  if (!existsSync(tokenomyGraphRootDir())) return null;
  try {
    const { repoId } = resolveRepoId(cwd);
    if (!existsSync(graphMetaPath(repoId))) return null;
    return (
      "[tokenomy: a local code graph snapshot exists for this repo. " +
      "If the `tokenomy-graph` MCP server is connected, prefer `get_minimal_context`, " +
      "`get_impact_radius`, or `get_review_context` before retrying broad `Read` calls.]"
    );
  } catch {
    return null;
  }
};

const preDispatchRead = (input: PreHookInput, cfg: Config): PreHookOutput | null => {
  const resolved = resolveReadPath(input);
  const r = readBoundRule(resolved, cfg);
  if (r.kind !== "clamp" || !r.updatedInput) return null;

  // Heuristic savings: we reduce the Read from its default (≈2000 lines) to
  // cfg.read.injected_limit lines. Assume ~50 bytes/line average.
  const assumedSkippedLines = Math.max(0, 2000 - (r.injectedLimit ?? 0));
  const bytesSavedEst = assumedSkippedLines * 50;

  const entry: SavingsLogEntry = {
    ts: new Date().toISOString(),
    session_id: input.session_id,
    tool: "Read",
    bytes_in: r.fileBytes ?? 0,
    bytes_out: (r.injectedLimit ?? 0) * 50,
    tokens_saved_est: estimateTokens(bytesSavedEst),
    reason: "read-clamp",
  };
  appendSavingsLog(cfg.log_path, entry);

  const hint = graphHint(input.cwd, cfg);
  const additionalContext = [r.additionalContext, hint].filter(Boolean).join(" ");

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: r.updatedInput,
      ...(additionalContext ? { additionalContext } : {}),
    },
  };
};

const preDispatchBash = (input: PreHookInput, cfg: Config): PreHookOutput | null => {
  const r = bashBoundRule(input.tool_input ?? {}, cfg);
  if (r.kind !== "bound" || !r.updatedInput) return null;

  // Pure heuristic: unbounded verbose shell commands average ~100 KB of
  // output in long sessions; the bounded variant returns head_limit * ~50 B.
  // Precise numbers come from `tokenomy analyze` replaying real transcripts.
  const assumedBytesOut = cfg.bash.head_limit * 50;
  const assumedBytesIn = Math.max(assumedBytesOut, 100_000);
  const bytesSavedEst = Math.max(0, assumedBytesIn - assumedBytesOut);

  const entry: SavingsLogEntry = {
    ts: new Date().toISOString(),
    session_id: input.session_id,
    tool: "Bash",
    bytes_in: assumedBytesIn,
    bytes_out: assumedBytesOut,
    tokens_saved_est: estimateTokens(bytesSavedEst),
    reason: `bash-bound:${r.patternName ?? "unknown"}`,
  };
  appendSavingsLog(cfg.log_path, entry);

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: r.updatedInput,
      ...(r.additionalContext ? { additionalContext: r.additionalContext } : {}),
    },
  };
};

const preDispatchWrite = (input: PreHookInput, cfg: Config): PreHookOutput | null => {
  const r = writeNudgeRule(input.tool_input ?? {}, cfg, input.cwd);
  if (r.kind !== "nudge" || !r.updatedInput) return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: r.updatedInput,
      ...(r.additionalContext ? { additionalContext: r.additionalContext } : {}),
    },
  };
};

export const preDispatch = (
  input: PreHookInput,
  cfg: Config,
): PreHookOutput | null => {
  if (cfg.disabled_tools.includes(input.tool_name)) return null;
  if (input.tool_name === "Read") return preDispatchRead(input, cfg);
  if (input.tool_name === "Bash") return preDispatchBash(input, cfg);
  if (input.tool_name === "Write") return preDispatchWrite(input, cfg);
  return null;
};

// Conservative token-savings estimates per intent. These are the typical
// downstream cost when an agent skips the MCP tool and brute-forces the
// alternative path (Read sweep, from-scratch implementation, etc.). Values
// tuned to the low end of the observed range so reports don't overstate.
// Bytes are back-calculated from tokens via the same ~4 bytes/token factor
// `estimateTokens` uses internally so `tokenomy report` aggregates sanely.
const INTENT_SAVINGS_TOKENS: Record<string, number> = {
  build: 15_000, // from-scratch rewrite of a utility that has a library
  change: 8_000, // brute-force Read sweep to enumerate callers
  remove: 5_000, // verification reads before a "safe" deletion
  review: 6_000, // reading every changed file vs hotspot-ranked list
};

export const dispatchUserPrompt = (
  input: UserPromptHookInput,
  cfg: Config,
): UserPromptHookOutput | null => {
  const r = classifyPromptRule(input.prompt ?? "", cfg, input.cwd);
  if (r.kind !== "nudge" || !r.additionalContext) return null;

  // Log a savings entry so `tokenomy report` and `tokenomy analyze` surface
  // these nudges alongside Read/Bash/MCP trims. Token estimates are
  // intentionally conservative — this is the value the nudge unlocks IF
  // the agent follows through on the MCP call, not a guaranteed saving.
  const tokensSavedEst = INTENT_SAVINGS_TOKENS[r.intent ?? ""] ?? 5_000;
  const bytesSavedEst = tokensSavedEst * 4;
  const entry: SavingsLogEntry = {
    ts: new Date().toISOString(),
    session_id: input.session_id,
    tool: "UserPromptSubmit",
    bytes_in: bytesSavedEst,
    bytes_out: 0,
    tokens_saved_est: tokensSavedEst,
    reason: `nudge:prompt-classifier:${r.intent ?? "unknown"}`,
  };
  appendSavingsLog(cfg.log_path, entry);

  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: r.additionalContext,
    },
  };
};
