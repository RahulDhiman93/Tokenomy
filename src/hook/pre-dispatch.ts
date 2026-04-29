import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type {
  Config,
  PreHookInput,
  PreHookOutput,
  SavingsLogEntry,
  SessionStartHookInput,
  SessionStartHookOutput,
  UserPromptHookInput,
  UserPromptHookOutput,
} from "../core/types.js";
import { readBoundRule } from "../rules/read-bound.js";
import { bashBoundRule } from "../rules/bash-bound.js";
import { writeNudgeRule } from "../rules/write-nudge.js";
import { classifyPromptRule } from "../rules/prompt-classifier.js";
import { redactPreRule } from "../rules/redact-pre.js";
import { budgetRule } from "../rules/budget.js";
import {
  buildGolemSessionContext,
  buildGolemTurnReminder,
  estimateGolemSavingsTokens,
  resolveGolemMode,
} from "../rules/golem.js";
import { buildRavenSessionContext, buildRavenTurnReminder } from "../raven/nudge.js";
import { evaluatePrompt as evaluateKratosPrompt } from "../kratos/prompt-rule.js";
import { shouldRefreshUpdateCache } from "../cli/statusline.js";
import { spawnUpdateCheck } from "../cli/update-check-spawn.js";
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
  // 0.1.5 round-5: if the rule sanitized invalid limit/offset on a
  // passthrough path (small file / doc passthrough), emit updatedInput
  // so Claude Code doesn't reuse the original bad values. No savings
  // log entry — there's no token saving to claim, just a defensive
  // input rewrite.
  if (r.kind === "passthrough" && r.updatedInput) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: r.updatedInput,
      },
    };
  }
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

const logRedactPre = (
  tool: string,
  sessionId: string,
  total: number,
  counts: Record<string, number>,
  cfg: Config,
): void => {
  const entry: SavingsLogEntry = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    tool,
    bytes_in: 0,
    bytes_out: 0,
    // Security-first rule: tokens_saved_est intentionally 0 — redact is
    // about preventing leaks, not about compression. The counts ride in
    // via `reason` so `tokenomy report` can surface pattern hits.
    tokens_saved_est: 0,
    reason: `redact-pre:${Object.keys(counts).join("+") || "detected"}:${total}`,
  };
  appendSavingsLog(cfg.log_path, entry);
};

const preDispatchBash = (input: PreHookInput, cfg: Config): PreHookOutput | null => {
  // Stage 0: pre-flight budget gate. Always advisory — never rewrites input,
  // only emits a warning in additionalContext so the agent sees the cost
  // before committing to the call. Runs first so its running-total update
  // happens exactly once per PreToolUse event even when later stages
  // passthrough.
  const budget = budgetRule(input.session_id, "Bash", cfg);
  let extraContext = budget.kind === "warn" && budget.additionalContext ? budget.additionalContext : "";

  // Stage 1: pre-call redact (no-op unless cfg.redact.pre_tool_use === true).
  let toolInput = input.tool_input ?? {};
  const rp = redactPreRule("Bash", toolInput, cfg);
  if (rp.kind === "redacted" && rp.updatedInput) {
    toolInput = { ...toolInput, ...rp.updatedInput };
    if (rp.additionalContext) extraContext = [extraContext, rp.additionalContext].filter(Boolean).join(" ");
    if (rp.total && rp.counts) logRedactPre("Bash", input.session_id, rp.total, rp.counts, cfg);
  } else if (rp.kind === "warned") {
    if (rp.additionalContext) extraContext = [extraContext, rp.additionalContext].filter(Boolean).join(" ");
    if (rp.total && rp.counts) logRedactPre("Bash", input.session_id, rp.total, rp.counts, cfg);
  }

  // Stage 2: bash-bound against the (possibly redacted) command.
  const r = bashBoundRule(toolInput, cfg);
  if (r.kind !== "bound" || !r.updatedInput) {
    // If any earlier stage produced a message (budget warning, redact
    // rewrite, or bare-arg warn) we still need to surface it.
    if ((rp.kind === "redacted" && rp.updatedInput) || rp.kind === "warned" || extraContext) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: toolInput,
          ...(extraContext ? { additionalContext: extraContext } : {}),
        },
      };
    }
    return null;
  }

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

  const combined = [extraContext, r.additionalContext].filter(Boolean).join(" ");
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: r.updatedInput,
      ...(combined ? { additionalContext: combined } : {}),
    },
  };
};

const preDispatchWrite = (input: PreHookInput, cfg: Config): PreHookOutput | null => {
  let toolInput = input.tool_input ?? {};
  let extraContext = "";
  const rp = redactPreRule("Write", toolInput, cfg);
  if (rp.kind === "redacted" && rp.updatedInput) {
    toolInput = { ...toolInput, ...rp.updatedInput };
    if (rp.additionalContext) extraContext = rp.additionalContext;
    if (rp.total && rp.counts) logRedactPre("Write", input.session_id, rp.total, rp.counts, cfg);
  }

  const r = writeNudgeRule(toolInput, cfg, input.cwd);
  if (r.kind !== "nudge" || !r.updatedInput) {
    if (rp.kind === "redacted" && rp.updatedInput) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput: toolInput,
          ...(extraContext ? { additionalContext: extraContext } : {}),
        },
      };
    }
    return null;
  }
  const combined = [extraContext, r.additionalContext].filter(Boolean).join(" ");
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: r.updatedInput,
      ...(combined ? { additionalContext: combined } : {}),
    },
  };
};

const preDispatchEdit = (input: PreHookInput, cfg: Config): PreHookOutput | null => {
  const toolInput = input.tool_input ?? {};
  const rp = redactPreRule("Edit", toolInput, cfg);
  if (rp.kind !== "redacted" || !rp.updatedInput) return null;
  if (rp.total && rp.counts) logRedactPre("Edit", input.session_id, rp.total, rp.counts, cfg);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: rp.updatedInput,
      ...(rp.additionalContext ? { additionalContext: rp.additionalContext } : {}),
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
  if (input.tool_name === "Edit") return preDispatchEdit(input, cfg);
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
  const golemReminder = buildGolemTurnReminder(cfg);
  const ravenReminder = buildRavenTurnReminder(input.prompt ?? "", cfg);
  // Kratos prompt-time scan (UserPromptSubmit). Continuous=false → static-only.
  const kratos =
    cfg.kratos?.enabled && cfg.kratos?.continuous
      ? evaluateKratosPrompt(input.prompt ?? "", cfg)
      : { flagged: false, findings: [], notice: "" };
  const kratosNotice = kratos.notice || null;
  if (kratos.flagged) {
    // Log the hit so `tokenomy report` and `tokenomy analyze` can surface
    // kratos activity. Token-savings value is 0 — kratos is about leak
    // prevention, not compression. Categories ride in `reason`.
    const cats = [...new Set(kratos.findings.map((f) => f.category))].join("+");
    appendSavingsLog(cfg.log_path, {
      ts: new Date().toISOString(),
      session_id: input.session_id,
      tool: "UserPromptSubmit",
      bytes_in: 0,
      bytes_out: 0,
      tokens_saved_est: 0,
      reason: `kratos:${cats}:${kratos.findings.length}`,
    });
  }

  if (r.kind === "nudge" && r.additionalContext) {
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

    // If Golem is active, append its per-turn reminder so the style rules
    // survive plugin drift even in turns where a classifier intent fires.
    const additionalContext = [r.additionalContext, golemReminder, ravenReminder, kratosNotice].filter(Boolean).join("\n\n");
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    };
  }

  // No classifier intent matched. Golem still needs its per-turn reminder
  // so other plugins can't shadow the style rules over time.
  if (golemReminder || ravenReminder || kratosNotice) {
    if (!golemReminder && (ravenReminder || kratosNotice)) {
      return {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: [ravenReminder, kratosNotice].filter(Boolean).join("\n\n"),
        },
      };
    }
    const resolvedMode = resolveGolemMode(cfg);
    const savingsTokens = estimateGolemSavingsTokens(resolvedMode);
    const entry: SavingsLogEntry = {
      ts: new Date().toISOString(),
      session_id: input.session_id,
      tool: "UserPromptSubmit",
      bytes_in: savingsTokens * 4,
      bytes_out: 0,
      tokens_saved_est: savingsTokens,
      reason: `golem:${resolvedMode}`,
    };
    appendSavingsLog(cfg.log_path, entry);
    return {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [golemReminder, ravenReminder, kratosNotice].filter(Boolean).join("\n\n"),
      },
    };
  }

  return null;
};

export const dispatchSessionStart = (
  input: SessionStartHookInput,
  cfg: Config,
): SessionStartHookOutput | null => {
  // 0.1.3+: refresh ~/.tokenomy/update-cache.json every SessionStart so
  // a fresh Claude Code session sees new Tokenomy releases on the
  // statusline within one tick of the next refresh. Throttled by the
  // statusline's 3h refresh window so rapid restarts don't pound npm.
  // Spawn is detached + unref'd; cannot block the hook's < 50ms budget.
  if (shouldRefreshUpdateCache()) spawnUpdateCheck();
  const ctx = buildGolemSessionContext(cfg);
  const raven = buildRavenSessionContext(cfg);
  const combined = [ctx, raven].filter(Boolean).join("\n\n");
  if (!combined) return null;
  // SessionStart fires once per session — log a single "golem:session-start"
  // event so `tokenomy report` can show Golem is active without double-
  // counting the per-turn reminders. Savings value is 0 here; the per-turn
  // path does the accounting.
  const entry: SavingsLogEntry = {
    ts: new Date().toISOString(),
    session_id: input.session_id,
    tool: "SessionStart",
    bytes_in: 0,
    bytes_out: 0,
    tokens_saved_est: 0,
    reason: ctx ? `golem:session-start:${resolveGolemMode(cfg)}` : "raven:session-start",
  };
  appendSavingsLog(cfg.log_path, entry);
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: combined,
    },
  };
};
