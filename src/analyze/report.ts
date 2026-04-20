import type { SimEvent } from "./simulate.js";

export interface AggregateReport {
  window: { first_ts: string | null; last_ts: string | null };
  totals: {
    files: number;
    sessions: number;
    tool_calls: number;
    observed_bytes: number;
    observed_tokens: number;
    savings_bytes: number;
    savings_tokens: number;
    redact_matches: number;
    duplicate_calls: number;
    estimated_usd_saved: number;
    estimated_usd_observed: number;
  };
  by_tool: Array<{
    tool: string;
    calls: number;
    observed_tokens: number;
    savings_tokens: number;
    waste_pct: number; // savings / observed
  }>;
  by_rule: Array<{ rule: string; savings_tokens: number; events: number }>;
  by_day: Array<{ day: string; observed_tokens: number; savings_tokens: number }>;
  hotspots: Array<{
    tool: string;
    calls: number;
    wasted_tokens: number; // observed tokens of repeats beyond the first
  }>;
  outliers: Array<{
    tool: string;
    tokens: number;
    bytes: number;
    ts: string;
    session_id: string;
  }>;
  tokenizer: { name: string; approximate: boolean };
}

export interface AggregatorOptions {
  top_n: number;
  price_per_million: number;
  tokenizer_name: string;
  tokenizer_approximate: boolean;
}

interface ToolBucket {
  calls: number;
  observed_tokens: number;
  savings_tokens: number;
}

interface KeyBucket {
  tool: string;
  calls: number;
  first_observed_tokens: number;
  wasted_tokens: number;
}

interface DayBucket {
  observed_tokens: number;
  savings_tokens: number;
}

export class Aggregator {
  private readonly opts: AggregatorOptions;
  private files = 0;
  private sessions = new Set<string>();
  private tool_calls = 0;
  private observed_bytes = 0;
  private observed_tokens = 0;
  private savings_bytes = 0;
  private savings_tokens = 0;
  private redact_matches = 0;
  private duplicate_calls = 0;
  private first_ts: string | null = null;
  private last_ts: string | null = null;

  private byTool = new Map<string, ToolBucket>();
  private byRule = new Map<string, { savings_tokens: number; events: number }>();
  private byDay = new Map<string, DayBucket>();
  private byKey = new Map<string, KeyBucket>();
  private outliers: AggregateReport["outliers"] = [];

  constructor(opts: AggregatorOptions) {
    this.opts = opts;
  }

  noteFile(): void {
    this.files++;
  }

  feed(e: SimEvent): void {
    this.tool_calls++;
    this.sessions.add(e.session_id);
    this.observed_bytes += e.observed_bytes;
    this.observed_tokens += e.observed_tokens;
    this.savings_bytes += e.savings_bytes;
    this.savings_tokens += e.savings_tokens;
    this.redact_matches += e.per_rule.redact_matches;
    if (e.duplicate_of_index !== undefined) this.duplicate_calls++;
    if (e.ts) {
      if (!this.first_ts || e.ts < this.first_ts) this.first_ts = e.ts;
      if (!this.last_ts || e.ts > this.last_ts) this.last_ts = e.ts;
    }

    // By tool.
    const bt = this.byTool.get(e.tool_name) ?? { calls: 0, observed_tokens: 0, savings_tokens: 0 };
    bt.calls++;
    bt.observed_tokens += e.observed_tokens;
    bt.savings_tokens += e.savings_tokens;
    this.byTool.set(e.tool_name, bt);

    // By rule.
    const rules: Array<[string, number]> = [
      ["dedup", e.per_rule.dedup],
      ["stacktrace", e.per_rule.stacktrace],
      ["profile", e.per_rule.profile],
      ["mcp_trim", e.per_rule.mcp_trim],
      ["read_clamp", e.per_rule.read_clamp],
      ["bash_bound", e.per_rule.bash_bound],
    ];
    for (const [name, saved] of rules) {
      if (saved <= 0) continue;
      const r = this.byRule.get(name) ?? { savings_tokens: 0, events: 0 };
      r.savings_tokens += saved;
      r.events++;
      this.byRule.set(name, r);
    }

    // By day (UTC date).
    if (e.ts.length >= 10) {
      const day = e.ts.slice(0, 10);
      const d = this.byDay.get(day) ?? { observed_tokens: 0, savings_tokens: 0 };
      d.observed_tokens += e.observed_tokens;
      d.savings_tokens += e.savings_tokens;
      this.byDay.set(day, d);
    }

    // Hotspots are session-scoped because real dedup is session-scoped.
    // Two separate sessions each calling the same tool once isn't a hotspot
    // dedup can fix, so we must not count them together. We also only count
    // repeats that the SIMULATOR actually flagged as duplicates — otherwise
    // we'd rank calls the live hook would miss (outside window_seconds,
    // below min_bytes, or with dedup disabled) as savable waste.
    const hotspotKey = `${e.session_id}\u0000${e.call_key}`;
    const kb = this.byKey.get(hotspotKey) ?? {
      tool: e.tool_name,
      calls: 0,
      first_observed_tokens: e.observed_tokens,
      wasted_tokens: 0,
    };
    kb.calls++;
    if (e.duplicate_of_index !== undefined) {
      kb.wasted_tokens += e.observed_tokens;
    }
    this.byKey.set(hotspotKey, kb);

    // Maintain a top-N outliers list (by observed tokens).
    this.maybeRecordOutlier(e);
  }

  private maybeRecordOutlier(e: SimEvent): void {
    // Treat non-positive top_n as "disable outlier tracking" rather than
    // letting a zero-size heap underflow on access.
    const n = this.opts.top_n;
    if (!Number.isFinite(n) || n <= 0) return;
    if (this.outliers.length < n) {
      this.outliers.push({
        tool: e.tool_name,
        tokens: e.observed_tokens,
        bytes: e.observed_bytes,
        ts: e.ts,
        session_id: e.session_id,
      });
      this.outliers.sort((a, b) => a.tokens - b.tokens);
      return;
    }
    const min = this.outliers[0]!;
    if (e.observed_tokens <= min.tokens) return;
    this.outliers[0] = {
      tool: e.tool_name,
      tokens: e.observed_tokens,
      bytes: e.observed_bytes,
      ts: e.ts,
      session_id: e.session_id,
    };
    this.outliers.sort((a, b) => a.tokens - b.tokens);
  }

  build(): AggregateReport {
    const top = this.opts.top_n;
    const byTool = [...this.byTool.entries()]
      .map(([tool, v]) => ({
        tool,
        calls: v.calls,
        observed_tokens: v.observed_tokens,
        savings_tokens: v.savings_tokens,
        waste_pct: v.observed_tokens > 0 ? v.savings_tokens / v.observed_tokens : 0,
      }))
      .sort((a, b) => b.savings_tokens - a.savings_tokens || b.observed_tokens - a.observed_tokens)
      .slice(0, top);

    const byRule = [...this.byRule.entries()]
      .map(([rule, v]) => ({ rule, savings_tokens: v.savings_tokens, events: v.events }))
      .sort((a, b) => b.savings_tokens - a.savings_tokens);

    const byDay = [...this.byDay.entries()]
      .map(([day, v]) => ({
        day,
        observed_tokens: v.observed_tokens,
        savings_tokens: v.savings_tokens,
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    const hotspots = [...this.byKey.values()]
      // Only surface keys the simulator actually credited as duplicates
      // (wasted_tokens > 0). A call_key that appeared twice but fell out
      // of the dedup window or was below min_bytes is not something the
      // live hook would save, so it doesn't belong on this list.
      .filter((k) => k.calls > 1 && k.wasted_tokens > 0)
      .map((k) => ({ tool: k.tool, calls: k.calls, wasted_tokens: k.wasted_tokens }))
      .sort((a, b) => b.wasted_tokens - a.wasted_tokens)
      .slice(0, top);

    const outliers = [...this.outliers].sort((a, b) => b.tokens - a.tokens);

    const usd_saved = (this.savings_tokens / 1_000_000) * this.opts.price_per_million;
    const usd_observed = (this.observed_tokens / 1_000_000) * this.opts.price_per_million;

    return {
      window: { first_ts: this.first_ts, last_ts: this.last_ts },
      totals: {
        files: this.files,
        sessions: this.sessions.size,
        tool_calls: this.tool_calls,
        observed_bytes: this.observed_bytes,
        observed_tokens: this.observed_tokens,
        savings_bytes: this.savings_bytes,
        savings_tokens: this.savings_tokens,
        redact_matches: this.redact_matches,
        duplicate_calls: this.duplicate_calls,
        estimated_usd_saved: usd_saved,
        estimated_usd_observed: usd_observed,
      },
      by_tool: byTool,
      by_rule: byRule,
      by_day: byDay,
      hotspots,
      outliers,
      tokenizer: {
        name: this.opts.tokenizer_name,
        approximate: this.opts.tokenizer_approximate,
      },
    };
  }
}
