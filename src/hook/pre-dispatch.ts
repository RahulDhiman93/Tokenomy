import { existsSync } from "node:fs";
import type { Config, PreHookInput, PreHookOutput, SavingsLogEntry } from "../core/types.js";
import { readBoundRule } from "../rules/read-bound.js";
import { estimateTokens } from "../core/gate.js";
import { appendSavingsLog } from "../core/log.js";
import { graphMetaPath, tokenomyGraphRootDir } from "../core/paths.js";
import { resolveRepoId } from "../graph/repo-id.js";

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
