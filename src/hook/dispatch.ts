import type { Config, HookInput, HookOutput, SavingsLogEntry } from "../core/types.js";
import { mcpContentRule } from "../rules/mcp-content.js";
import { shellTraceRule } from "../rules/shell-trace.js";
import { estimateTokens, shouldApply } from "../core/gate.js";
import { appendSavingsLog } from "../core/log.js";
import { configForTool, resolveToolOverride } from "../core/config.js";
import { checkAndRecordDuplicate, duplicateResponseBody } from "../core/dedup.js";

export const dispatch = (input: HookInput, cfg: Config): HookOutput | null => {
  if (!input.tool_name || (!input.tool_name.startsWith("mcp__") && input.tool_name !== "Bash")) {
    return null;
  }
  if (cfg.disabled_tools.includes(input.tool_name)) return null;

  const toolCfg = configForTool(cfg, input.tool_name);
  const toolOverride = resolveToolOverride(cfg, input.tool_name);

  if (input.tool_name === "Bash") {
    if (toolOverride?.disable_trace_trim) return null;
    const result = shellTraceRule(input.tool_name, input.tool_response, toolCfg);
    if (result.kind === "passthrough") return null;
    if (!shouldApply(result.bytesIn, result.bytesOut, toolCfg)) return null;
    appendSavingsLog(toolCfg.log_path, {
      ts: new Date().toISOString(),
      session_id: input.session_id,
      tool: input.tool_name,
      bytes_in: result.bytesIn,
      bytes_out: result.bytesOut,
      tokens_saved_est: estimateTokens(result.bytesIn - result.bytesOut),
      reason: result.reason,
    });
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedMCPToolOutput: result.output,
      },
    };
  }

  // Stage -1: duplicate detection. If this exact tool + args was called earlier
  // in the session and still within the dedup window, replace the body with a
  // stub pointer. This saves full token cost, not just trim overhead.
  const dup = checkAndRecordDuplicate(input, toolCfg);
  if (dup.duplicate && dup.stubOutput) {
    const entry: SavingsLogEntry = {
      ts: new Date().toISOString(),
      session_id: input.session_id,
      tool: input.tool_name,
      bytes_in: dup.bytesIn,
      bytes_out: dup.bytesOut,
      tokens_saved_est: estimateTokens(dup.bytesIn - dup.bytesOut),
      reason: `dedup:#${dup.firstIndex}`,
    };
    appendSavingsLog(toolCfg.log_path, entry);
    return {
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        updatedMCPToolOutput: dup.stubOutput,
      },
    };
  }

  const result = mcpContentRule(
    input.tool_name,
    input.tool_input ?? {},
    input.tool_response,
    toolCfg,
  );
  if (result.kind === "passthrough") return null;

  // Redaction matches force-apply regardless of savings gate (security > tokens).
  const redactionForced = /redact:\d+/.test(result.reason);
  if (!redactionForced && !shouldApply(result.bytesIn, result.bytesOut, toolCfg)) {
    return null;
  }

  const entry: SavingsLogEntry = {
    ts: new Date().toISOString(),
    session_id: input.session_id,
    tool: input.tool_name,
    bytes_in: result.bytesIn,
    bytes_out: result.bytesOut,
    tokens_saved_est: estimateTokens(result.bytesIn - result.bytesOut),
    reason: result.reason,
  };
  appendSavingsLog(toolCfg.log_path, entry);

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedMCPToolOutput: result.output,
    },
  };
};

// Re-export for tests that import from the dispatch surface.
export { duplicateResponseBody };
