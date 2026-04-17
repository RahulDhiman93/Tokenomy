import type { Config, PreHookInput, PreHookOutput, SavingsLogEntry } from "../core/types.js";
import { readBoundRule } from "../rules/read-bound.js";
import { estimateTokens } from "../core/gate.js";
import { appendSavingsLog } from "../core/log.js";

export const preDispatch = (
  input: PreHookInput,
  cfg: Config,
): PreHookOutput | null => {
  if (cfg.disabled_tools.includes(input.tool_name)) return null;
  if (input.tool_name !== "Read") return null;

  const r = readBoundRule(input.tool_input ?? {}, cfg);
  if (r.kind !== "clamp" || !r.updatedInput) return null;

  // Heuristic savings: we reduce the Read from its default (≈2000 lines) to
  // cfg.read.injected_limit lines. Assume ~50 bytes/line average.
  const assumedSkippedLines = Math.max(0, 2000 - (r.injectedLimit ?? 0));
  const bytesSavedEst = assumedSkippedLines * 50;

  const entry: SavingsLogEntry = {
    ts: new Date().toISOString(),
    session_id: input.session_id,
    tool: "Read",
    bytes_in: (r.fileBytes ?? 0),
    bytes_out: (r.injectedLimit ?? 0) * 50,
    tokens_saved_est: estimateTokens(bytesSavedEst),
    reason: "read-clamp",
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
