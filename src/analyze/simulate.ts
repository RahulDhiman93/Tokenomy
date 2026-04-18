import { createHash } from "node:crypto";
import type { Config } from "../core/types.js";
import { mcpContentRule } from "../rules/mcp-content.js";
import { BUILTIN_PATTERNS, redactSecrets } from "../rules/redact.js";
import { collapseStacktrace } from "../rules/stacktrace.js";
import { readBoundRule } from "../rules/read-bound.js";
import type { ToolCall } from "./parse.js";
import type { Tokenizer } from "./tokens.js";

// Per-event sim result: what would Tokenomy have saved if it had been active?
// `observed_tokens` is the actual token cost of this tool response.
// `savings_tokens` is the hypothetical save after running the full pipeline.
export interface SimEvent {
  agent: ToolCall["agent"];
  session_id: string;
  project_hint: string;
  ts: string;
  tool_name: string;
  observed_bytes: number;
  observed_tokens: number;
  savings_bytes: number;
  savings_tokens: number;
  // Per-rule breakdowns (tokens each rule would have saved on its own).
  per_rule: {
    dedup: number;
    redact_matches: number; // count, not bytes — redact is security-first
    stacktrace: number;
    profile: number;
    mcp_trim: number;
    read_clamp: number;
  };
  // dedup pointer: if this event was a duplicate of an earlier one, index.
  duplicate_of_index?: number;
  // canonicalized key for cross-session hotspot aggregation.
  call_key: string;
}

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) out[k] = canonicalize((value as Record<string, unknown>)[k]);
  return out;
};

const callKey = (toolName: string, toolInput: Record<string, unknown>): string =>
  createHash("sha256")
    .update(toolName)
    .update("\u0000")
    .update(JSON.stringify(canonicalize(toolInput ?? {})))
    .digest("hex");

// Extract the raw textual payload from a tool response (used for token count
// and for running text-based rules like redact + stacktrace).
const asText = (response: unknown): string => {
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
    if (Array.isArray(content)) return asText(content);
  }
  return "";
};

const responseBytesFromTokens = (resp: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(resp ?? null), "utf8");
  } catch {
    return 0;
  }
};

export interface SimulatorOptions {
  cfg: Config;
  tokenizer: Tokenizer;
  // If true, the per-session dedup state is cleared when session_id changes.
  // Default true — matches how Tokenomy's real dedup works.
  session_scoped_dedup?: boolean;
}

// Session-scoped dedup ledger used during simulation. Entries are the
// observed tokens of the *first* call with that key in the current session.
interface DedupEntry {
  index: number;
  tokens: number;
  bytes: number;
}

export class Simulator {
  private readonly cfg: Config;
  private readonly tokenizer: Tokenizer;
  private readonly scoped: boolean;
  private currentSession: string | null = null;
  private dedupLedger = new Map<string, DedupEntry>();
  private sessionCounter = 0;

  constructor(opts: SimulatorOptions) {
    this.cfg = opts.cfg;
    this.tokenizer = opts.tokenizer;
    this.scoped = opts.session_scoped_dedup !== false;
  }

  feed(call: ToolCall): SimEvent {
    if (this.scoped && call.session_id !== this.currentSession) {
      this.currentSession = call.session_id;
      this.dedupLedger.clear();
      this.sessionCounter = 0;
    }
    this.sessionCounter++;

    const text = asText(call.tool_response);
    const observed_tokens = this.tokenizer.count(text || JSON.stringify(call.tool_response ?? ""));
    const observed_bytes = call.response_bytes;

    const perRule: SimEvent["per_rule"] = {
      dedup: 0,
      redact_matches: 0,
      stacktrace: 0,
      profile: 0,
      mcp_trim: 0,
      read_clamp: 0,
    };

    let savings_tokens = 0;
    let savings_bytes = 0;
    let duplicate_of_index: number | undefined;

    const key = callKey(call.tool_name, call.tool_input);

    // Rule 1: dedup. If the same call appeared earlier in this session, a
    // stub body would replace the full response — savings = observed tokens
    // minus a short pointer.
    if (this.cfg.dedup?.enabled !== false) {
      const prev = this.dedupLedger.get(key);
      const minBytes = this.cfg.dedup?.min_bytes ?? 2_000;
      if (prev && observed_bytes >= minBytes) {
        // Stub roughly: 1 text block with a 120-byte pointer line.
        const stubTokens = this.tokenizer.count(
          `[tokenomy: duplicate of call #${prev.index} at ${call.ts} — body elided, no refetch required.]`,
        );
        const saved = Math.max(0, observed_tokens - stubTokens);
        perRule.dedup = saved;
        savings_tokens += saved;
        savings_bytes += Math.max(0, observed_bytes - 200);
        duplicate_of_index = prev.index;
      } else if (observed_bytes >= minBytes) {
        this.dedupLedger.set(key, {
          index: this.sessionCounter,
          tokens: observed_tokens,
          bytes: observed_bytes,
        });
      }
    }

    // If deduped, short-circuit other rules (stub would replace the body).
    if (duplicate_of_index === undefined) {
      // Rule 2: redaction match count (informational).
      if (text && this.cfg.redact?.enabled !== false) {
        const r = redactSecrets(text, BUILTIN_PATTERNS);
        perRule.redact_matches = r.total;
      }

      // Rule 3: stacktrace collapse.
      if (text) {
        const s = collapseStacktrace(text);
        if (s.ok && s.trimmed) {
          const newTokens = this.tokenizer.count(s.trimmed);
          const saved = Math.max(0, observed_tokens - newTokens);
          perRule.stacktrace = saved;
          savings_tokens += saved;
          savings_bytes += Math.max(0, s.bytesIn - s.bytesOut);
        }
      }

      // Rule 4 + 5: full MCP pipeline (profile trim + byte trim).
      if (call.tool_name.startsWith("mcp__") && call.tool_response) {
        const r = mcpContentRule(call.tool_name, call.tool_input, call.tool_response, this.cfg);
        if (r.kind === "trim") {
          const newText = asText(r.output);
          const newTokens = this.tokenizer.count(newText);
          const saved = Math.max(0, observed_tokens - newTokens);
          // Split between profile vs trim reason, best-effort.
          if (r.reason.includes("profile")) perRule.profile = saved;
          else perRule.mcp_trim = saved;
          savings_tokens += saved;
          savings_bytes += Math.max(0, r.bytesIn - r.bytesOut);
        }
      }

      // Rule 6: Read clamp. Applies when tool is Read, response is big, and
      // there was no explicit limit/offset in the input.
      if (call.tool_name === "Read" && this.cfg.read.enabled) {
        const fileBytes = observed_bytes;
        const input = call.tool_input;
        const hasExplicit =
          typeof input["limit"] === "number" || typeof input["offset"] === "number";
        if (!hasExplicit && fileBytes >= this.cfg.read.clamp_above_bytes) {
          // Estimated savings: keeps injected_limit lines at ~50 B/line.
          const keptBytes = this.cfg.read.injected_limit * 50;
          const keptTokens = this.tokenizer.count("x".repeat(keptBytes)); // rough
          const saved = Math.max(0, observed_tokens - keptTokens);
          perRule.read_clamp = saved;
          savings_tokens += saved;
          savings_bytes += Math.max(0, fileBytes - keptBytes);
        }
      }
    }

    return {
      agent: call.agent,
      session_id: call.session_id,
      project_hint: call.project_hint,
      ts: call.ts,
      tool_name: call.tool_name,
      observed_bytes,
      observed_tokens,
      savings_bytes,
      savings_tokens,
      per_rule: perRule,
      ...(duplicate_of_index !== undefined ? { duplicate_of_index } : {}),
      call_key: key,
    };
  }
}

// Unused import suppressor: keeps readBoundRule callable via re-export to
// preserve the symmetry with the real hook pipeline. Downstream consumers
// can use this to simulate PreToolUse behaviour for ad-hoc fixtures.
export const simulateReadClamp = readBoundRule;
