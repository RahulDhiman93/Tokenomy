import type { Config, HookInput, HookOutput, SavingsLogEntry } from "../core/types.js";
import { mcpContentRule } from "../rules/mcp-content.js";
import { estimateTokens, shouldApply } from "../core/gate.js";
import { appendSavingsLog } from "../core/log.js";

export const dispatch = (input: HookInput, cfg: Config): HookOutput | null => {
  if (!input.tool_name || !input.tool_name.startsWith("mcp__")) return null;
  if (cfg.disabled_tools.includes(input.tool_name)) return null;

  const result = mcpContentRule(
    input.tool_name,
    input.tool_input ?? {},
    input.tool_response,
    cfg,
  );
  if (result.kind === "passthrough") return null;

  if (!shouldApply(result.bytesIn, result.bytesOut, cfg)) return null;

  const entry: SavingsLogEntry = {
    ts: new Date().toISOString(),
    session_id: input.session_id,
    tool: input.tool_name,
    bytes_in: result.bytesIn,
    bytes_out: result.bytesOut,
    tokens_saved_est: estimateTokens(result.bytesIn - result.bytesOut),
    reason: result.reason,
  };
  appendSavingsLog(cfg.log_path, entry);

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedMCPToolOutput: result.output,
    },
  };
};
