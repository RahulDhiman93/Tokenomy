import { existsSync, readFileSync } from "node:fs";
import { analyzeCachePath } from "../core/paths.js";
import type { Config } from "../core/types.js";
import { readSessionState, updateSessionState } from "../core/session-state.js";
import { safeParse } from "../util/json.js";

export interface BudgetResult {
  kind: "passthrough" | "warn";
  additionalContext?: string;
  estimated_tokens?: number;
  // Always updated when the rule fires (enabled + non-excluded tool).
  running_total_after?: number;
}

interface AnalyzeCache {
  generated_ts?: string;
  byTool?: Record<
    string,
    {
      calls?: number;
      mean_tokens_per_call?: number;
      p95_latency_ms?: number | null;
    }
  >;
}

const loadCache = (): AnalyzeCache | null => {
  try {
    const path = analyzeCachePath();
    if (!existsSync(path)) return null;
    return safeParse<AnalyzeCache>(readFileSync(path, "utf8")) ?? null;
  } catch {
    return null;
  }
};

const estimateCallTokens = (toolName: string, cache: AnalyzeCache | null): number => {
  if (!cache?.byTool) return 0;
  const row = cache.byTool[toolName];
  if (!row || typeof row.mean_tokens_per_call !== "number") return 0;
  return Math.max(0, row.mean_tokens_per_call);
};

// PreToolUse budget gate. Never rejects; emits a warning in
// `additionalContext` when (a) the estimate exceeds `warn_threshold_tokens`
// AND (b) running_total + estimate would exceed `session_cap_tokens`.
//
// Always updates session running total on non-excluded tools so subsequent
// calls see the accumulated cost, even when no warning fires.
export const budgetRule = (
  sessionId: string,
  toolName: string,
  cfg: Config,
): BudgetResult => {
  try {
    const budget = cfg.budget;
    if (!budget || budget.enabled !== true) return { kind: "passthrough" };
    if (budget.exclude_tools?.includes(toolName)) return { kind: "passthrough" };

    const cache = loadCache();
    const estimated = estimateCallTokens(toolName, cache);
    const prev = readSessionState(sessionId);
    const runningBefore = prev?.running_estimated_tokens ?? 0;

    // Always update so cumulative state is accurate even if we pass through.
    const next = updateSessionState(sessionId, estimated, toolName);

    if (estimated <= 0) return { kind: "passthrough", running_total_after: next.running_estimated_tokens };
    if (estimated < budget.warn_threshold_tokens) {
      return { kind: "passthrough", estimated_tokens: estimated, running_total_after: next.running_estimated_tokens };
    }
    const projectedTotal = runningBefore + estimated;
    if (projectedTotal <= budget.session_cap_tokens) {
      return { kind: "passthrough", estimated_tokens: estimated, running_total_after: next.running_estimated_tokens };
    }

    return {
      kind: "warn",
      estimated_tokens: estimated,
      running_total_after: next.running_estimated_tokens,
      additionalContext:
        `[tokenomy-budget: this ${toolName} call is estimated to return ~${estimated.toLocaleString("en-US")} tokens. ` +
        `Session running total: ${runningBefore.toLocaleString("en-US")} / ${budget.session_cap_tokens.toLocaleString("en-US")}. ` +
        `Consider scoping the query (by key, path, or time window) before sending.]`,
    };
  } catch {
    return { kind: "passthrough" };
  }
};
