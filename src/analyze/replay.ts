import type { Config } from "../core/types.js";
import type { ToolCall } from "./parse.js";
import type { Tokenizer } from "./tokens.js";
import { Simulator, type SimEvent } from "./simulate.js";

// Replay one historical ToolCall through the full rule stack and return both
// the raw SimEvent (per-rule attribution) and the trimmed-text shape so the
// caller can build a before/after diff.
export interface ReplayResult {
  event: SimEvent;
  before: string; // raw observed response text
  afterTokens: number; // observed_tokens - savings_tokens
  beforeTokens: number; // observed_tokens
}

// Render the tool_response into a stable text form suitable for diff display
// and token counting. Mirrors Simulator.asText but exposed for the CLI path.
export const responseAsText = (response: unknown): string => {
  if (response === null || response === undefined) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    return response
      .map((b) => {
        if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
          const t = (b as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("\n");
  }
  if (typeof response === "object") {
    const content = (response as { content?: unknown }).content;
    if (Array.isArray(content)) return responseAsText(content);
    try {
      return JSON.stringify(response, null, 2);
    } catch {
      return "";
    }
  }
  return String(response);
};

export const replayOne = (call: ToolCall, cfg: Config, tokenizer: Tokenizer): ReplayResult => {
  const sim = new Simulator({ cfg, tokenizer });
  const event = sim.feed(call);
  const before = responseAsText(call.tool_response);
  return {
    event,
    before,
    beforeTokens: event.observed_tokens,
    afterTokens: Math.max(0, event.observed_tokens - event.savings_tokens),
  };
};
