import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Config } from "../core/types.js";
import { mcpContentRule } from "../rules/mcp-content.js";
import { readBoundRule } from "../rules/read-bound.js";
import { shouldApply } from "../core/gate.js";
import { configForTool, loadConfig, resolveToolOverride } from "../core/config.js";
import type { ToolCall } from "./parse.js";
import type { Tokenizer } from "./tokens.js";

// Per-event sim result: what would Tokenomy have saved if it had been active?
// `observed_tokens` is the actual token cost of this tool response.
// `savings_tokens` is the hypothetical save after running the full pipeline.
//
// Fidelity invariant: the simulator mirrors the real `dispatch()` /
// `preDispatch()` logic exactly — a rule is only credited if the live hook
// would have fired it. In particular: PostToolUse rules (dedup, redact,
// stacktrace, profile, mcp-trim) only run for `mcp__*` tools; `Read`
// clamp is the only thing that fires for non-MCP calls.
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

// Parse the "redact:N+profile:foo+stacktrace+mcp-content-trim" reason string
// that mcp-content-rule emits. Returns which stages fired.
interface ReasonFlags {
  redact_count: number;
  stacktrace: boolean;
  profile: boolean;
  mcp_trim: boolean;
}
const parseReason = (reason: string): ReasonFlags => {
  const redactMatch = /redact:(\d+)/.exec(reason);
  return {
    redact_count: redactMatch ? parseInt(redactMatch[1]!, 10) : 0,
    stacktrace: /stacktrace/.test(reason),
    profile: /profile:/.test(reason),
    mcp_trim: /mcp-content-trim/.test(reason),
  };
};

export interface SimulatorOptions {
  // Default (fallback) config, used when a ToolCall has no resolvable
  // project_hint or the per-project override file doesn't exist.
  cfg: Config;
  tokenizer: Tokenizer;
  // If true, the per-session dedup state is cleared when session_id changes.
  // Default true — matches how Tokenomy's real dedup works.
  session_scoped_dedup?: boolean;
}

interface DedupEntry {
  index: number;
  ts: string; // ISO timestamp of the first occurrence, for window_seconds check.
  tokens: number;
  bytes: number;
}

const withinWindow = (priorTs: string, currentTs: string, windowSeconds: number): boolean => {
  const p = Date.parse(priorTs);
  const c = Date.parse(currentTs);
  // If either timestamp is unparseable, assume same window (fail-open —
  // matches the real dedup path which uses Date.now).
  if (!Number.isFinite(p) || !Number.isFinite(c)) return true;
  return Math.abs(c - p) <= windowSeconds * 1_000;
};

export class Simulator {
  private readonly cfg: Config;
  private readonly tokenizer: Tokenizer;
  private readonly scoped: boolean;
  // Nested per-session dedup ledgers so events can stream in any order
  // (including sidechain files that revisit a parent session) without
  // resetting state. Memory is bounded by unique (session, call_key)
  // pairs — not raw response bodies — so this scales to large corpora.
  private readonly ledgers = new Map<string, Map<string, DedupEntry>>();
  private readonly sessionCounters = new Map<string, number>();
  // Per-project config cache: avoid re-loading + re-scaling on every event.
  // Key is the absolute project path (ToolCall.project_hint) when it
  // resolves to an existing directory; otherwise the fallback cfg is used.
  private readonly projectCfgCache = new Map<string, Config>();

  constructor(opts: SimulatorOptions) {
    this.cfg = opts.cfg;
    this.tokenizer = opts.tokenizer;
    this.scoped = opts.session_scoped_dedup !== false;
  }

  private ledgerFor(sessionId: string): Map<string, DedupEntry> {
    if (!this.scoped) {
      // All events share one ledger.
      let ledger = this.ledgers.get("_global");
      if (!ledger) {
        ledger = new Map();
        this.ledgers.set("_global", ledger);
      }
      return ledger;
    }
    let ledger = this.ledgers.get(sessionId);
    if (!ledger) {
      ledger = new Map();
      this.ledgers.set(sessionId, ledger);
    }
    return ledger;
  }

  private nextCounter(sessionId: string): number {
    const key = this.scoped ? sessionId : "_global";
    const n = (this.sessionCounters.get(key) ?? 0) + 1;
    this.sessionCounters.set(key, n);
    return n;
  }

  private configForEvent(call: ToolCall): Config {
    const hint = call.project_hint;
    if (!hint || !hint.startsWith("/") || !existsSync(hint)) return this.cfg;
    const cached = this.projectCfgCache.get(hint);
    if (cached) return cached;
    try {
      const loaded = loadConfig(hint);
      this.projectCfgCache.set(hint, loaded);
      return loaded;
    } catch {
      this.projectCfgCache.set(hint, this.cfg);
      return this.cfg;
    }
  }

  feed(call: ToolCall): SimEvent {
    const ledger = this.ledgerFor(call.session_id);
    const counter = this.nextCounter(call.session_id);

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
    const isMcp = call.tool_name.startsWith("mcp__");
    const isRead = call.tool_name === "Read";

    // Use per-project config when the ToolCall carries a resolvable cwd.
    // This matches how the real hook's `loadConfig(input.cwd)` picks up
    // `<project>/.tokenomy.json` overrides in addition to the global cfg.
    const projectCfg = this.configForEvent(call);
    // Honor disabled_tools and per-tool overrides exactly like the real
    // dispatch does. A tool explicitly disabled gets no simulated savings;
    // per-tool aggression overrides flow into the downstream rule configs.
    if (projectCfg.disabled_tools?.includes(call.tool_name)) {
      return {
        agent: call.agent,
        session_id: call.session_id,
        project_hint: call.project_hint,
        ts: call.ts,
        tool_name: call.tool_name,
        observed_bytes,
        observed_tokens,
        savings_bytes: 0,
        savings_tokens: 0,
        per_rule: perRule,
        call_key: key,
      };
    }
    const toolCfg = configForTool(projectCfg, call.tool_name);

    // PostToolUse rules only fire for mcp__* tools in the real dispatch.
    // Non-MCP tools get only the Read-clamp path (handled separately below).
    if (isMcp) {
      // Rule 1: dedup with session scope + window_seconds gate + per-tool
      // `disable_dedup` override (matches the live dispatch path).
      const toolOverride = resolveToolOverride(projectCfg, call.tool_name);
      const dedupEnabled =
        toolCfg.dedup?.enabled !== false && toolOverride?.disable_dedup !== true;
      if (dedupEnabled) {
        const minBytes = toolCfg.dedup?.min_bytes ?? 2_000;
        const windowSeconds = toolCfg.dedup?.window_seconds ?? 1_800;
        const prev = ledger.get(key);
        if (
          prev &&
          observed_bytes >= minBytes &&
          withinWindow(prev.ts, call.ts, windowSeconds)
        ) {
          const stubTokens = this.tokenizer.count(
            `[tokenomy: duplicate of call #${prev.index} at ${call.ts} — body elided, no refetch required.]`,
          );
          const saved = Math.max(0, observed_tokens - stubTokens);
          perRule.dedup = saved;
          savings_tokens += saved;
          savings_bytes += Math.max(0, observed_bytes - 200);
          duplicate_of_index = prev.index;
        } else if (observed_bytes >= minBytes) {
          // Record (or refresh) for future-duplicate detection.
          ledger.set(key, {
            index: counter,
            ts: call.ts,
            tokens: observed_tokens,
            bytes: observed_bytes,
          });
        }
      }

      // If deduped, the live hook short-circuits — no other rules fire.
      if (duplicate_of_index === undefined && call.tool_response) {
        // Single-shot pipeline: mcp-content-rule internally runs
        // redact → stacktrace → profile → mcp-trim. Parsing the returned
        // `reason` lets us split the credit across those stages without
        // running them separately (which was double-counting).
        const r = mcpContentRule(
          call.tool_name,
          call.tool_input,
          call.tool_response,
          toolCfg,
        );
        if (r.kind === "trim") {
          const flags = parseReason(r.reason);
          // Match dispatch: redaction force-applies regardless of gate.
          const redactionForced = flags.redact_count > 0;
          if (redactionForced || shouldApply(r.bytesIn, r.bytesOut, toolCfg)) {
            const newText = asText(r.output);
            const newTokens = this.tokenizer.count(newText);
            const saved = Math.max(0, observed_tokens - newTokens);
            // Split savings attribution by which stage fired.
            if (flags.profile) perRule.profile = saved;
            else if (flags.mcp_trim) perRule.mcp_trim = saved;
            else if (flags.stacktrace) perRule.stacktrace = saved;
            savings_tokens += saved;
            savings_bytes += Math.max(0, r.bytesIn - r.bytesOut);
            perRule.redact_matches = flags.redact_count;
          }
        }
      }
    } else if (isRead && toolCfg.read.enabled) {
      // Rule 6: Read clamp. Mirrors preDispatch logic: no clamp if the user
      // passed explicit limit/offset, only fires above clamp_above_bytes,
      // AND — unlike the earlier naive "injected_limit * 50 B" estimate —
      // uses the actual newline count from the observed transcript text so
      // we don't falsely credit savings on minified or single-line files.
      const input = call.tool_input;
      const hasExplicit =
        typeof input["limit"] === "number" || typeof input["offset"] === "number";
      if (!hasExplicit && observed_bytes >= toolCfg.read.clamp_above_bytes) {
        const body = text;
        // Count lines; if there aren't more than injected_limit there's
        // nothing to clamp — a single-line 80KB minified bundle stays
        // 80KB after `limit:500`.
        let newlines = 0;
        for (let i = 0; i < body.length; i++) if (body.charCodeAt(i) === 10) newlines++;
        const totalLines = newlines + 1;
        const kept = Math.min(totalLines, toolCfg.read.injected_limit);
        if (kept < totalLines) {
          const kept_ratio = kept / totalLines;
          const keptTokens = Math.ceil(observed_tokens * kept_ratio);
          const saved = Math.max(0, observed_tokens - keptTokens);
          perRule.read_clamp = saved;
          savings_tokens += saved;
          savings_bytes += Math.max(0, observed_bytes - Math.ceil(observed_bytes * kept_ratio));
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

// Re-exported for symmetry with the real hook pipeline; downstream consumers
// can simulate PreToolUse behaviour directly against ad-hoc fixtures.
export const simulateReadClamp = readBoundRule;
