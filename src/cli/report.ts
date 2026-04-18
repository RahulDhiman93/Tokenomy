import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../util/atomic.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { defaultLogPath, tokenomyDir } from "../core/paths.js";
import { safeParse } from "../util/json.js";
import type { Config, SavingsLogEntry } from "../core/types.js";
import { globalConfigPath } from "../core/paths.js";

// Per-1M-token pricing (USD). Used purely to estimate $ saved for the
// "tokens saved" column. Users can override via `tokenomy config set
// report.price_per_million 15`.
const DEFAULT_PRICE_PER_MILLION = 3.0; // Claude Sonnet input-token price.

export interface ReportOptions {
  since?: Date; // only include entries on/after this date
  top: number; // limit for per-tool/reason rankings
  out?: string; // HTML output path
  pricePerMillion?: number;
}

export interface ReportSummary {
  total_calls: number;
  total_bytes_in: number;
  total_bytes_out: number;
  total_tokens_saved: number;
  estimated_usd_saved: number;
  by_tool: { tool: string; calls: number; tokens_saved: number }[];
  by_reason: { reason: string; calls: number; tokens_saved: number }[];
  by_day: { day: string; calls: number; tokens_saved: number }[];
  window: { first_ts: string | null; last_ts: string | null };
}

const readEntries = (logPath: string, since?: Date): SavingsLogEntry[] => {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf8");
  const out: SavingsLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parsed = safeParse<SavingsLogEntry>(line);
    if (!parsed || typeof parsed.ts !== "string") continue;
    if (since && Date.parse(parsed.ts) < since.getTime()) continue;
    out.push(parsed);
  }
  return out;
};

export const summarize = (
  entries: SavingsLogEntry[],
  opts: { top: number; pricePerMillion: number },
): ReportSummary => {
  const byTool = new Map<string, { calls: number; tokens: number }>();
  const byReason = new Map<string, { calls: number; tokens: number }>();
  const byDay = new Map<string, { calls: number; tokens: number }>();
  let bytesIn = 0;
  let bytesOut = 0;
  let tokens = 0;
  let first: string | null = null;
  let last: string | null = null;

  for (const e of entries) {
    bytesIn += e.bytes_in ?? 0;
    bytesOut += e.bytes_out ?? 0;
    tokens += e.tokens_saved_est ?? 0;
    if (!first || e.ts < first) first = e.ts;
    if (!last || e.ts > last) last = e.ts;

    const tool = e.tool ?? "<unknown>";
    const reason = (e.reason ?? "<unknown>").split(":")[0] ?? "<unknown>";
    const day = e.ts.slice(0, 10);

    const t = byTool.get(tool) ?? { calls: 0, tokens: 0 };
    t.calls++;
    t.tokens += e.tokens_saved_est ?? 0;
    byTool.set(tool, t);

    const r = byReason.get(reason) ?? { calls: 0, tokens: 0 };
    r.calls++;
    r.tokens += e.tokens_saved_est ?? 0;
    byReason.set(reason, r);

    const d = byDay.get(day) ?? { calls: 0, tokens: 0 };
    d.calls++;
    d.tokens += e.tokens_saved_est ?? 0;
    byDay.set(day, d);
  }

  const toolRanking = [...byTool.entries()]
    .map(([tool, v]) => ({ tool, calls: v.calls, tokens_saved: v.tokens }))
    .sort((a, b) => b.tokens_saved - a.tokens_saved)
    .slice(0, opts.top);

  const reasonRanking = [...byReason.entries()]
    .map(([reason, v]) => ({ reason, calls: v.calls, tokens_saved: v.tokens }))
    .sort((a, b) => b.tokens_saved - a.tokens_saved);

  const dayRanking = [...byDay.entries()]
    .map(([day, v]) => ({ day, calls: v.calls, tokens_saved: v.tokens }))
    .sort((a, b) => a.day.localeCompare(b.day));

  return {
    total_calls: entries.length,
    total_bytes_in: bytesIn,
    total_bytes_out: bytesOut,
    total_tokens_saved: tokens,
    estimated_usd_saved: (tokens / 1_000_000) * opts.pricePerMillion,
    by_tool: toolRanking,
    by_reason: reasonRanking,
    by_day: dayRanking,
    window: { first_ts: first, last_ts: last },
  };
};

const fmtNum = (n: number): string => n.toLocaleString("en-US");

const renderTui = (s: ReportSummary): string => {
  const lines: string[] = [];
  lines.push("tokenomy report");
  lines.push("===============");
  lines.push("");
  lines.push(`Window:            ${s.window.first_ts ?? "—"}  →  ${s.window.last_ts ?? "—"}`);
  lines.push(`Total events:      ${fmtNum(s.total_calls)}`);
  lines.push(`Bytes trimmed:     ${fmtNum(s.total_bytes_in)} → ${fmtNum(s.total_bytes_out)}  ` +
    `(−${fmtNum(s.total_bytes_in - s.total_bytes_out)})`);
  lines.push(`Tokens saved (est): ${fmtNum(s.total_tokens_saved)}`);
  lines.push(`~USD saved:        $${s.estimated_usd_saved.toFixed(4)}`);
  lines.push("");
  lines.push("Top tools by tokens saved");
  for (const t of s.by_tool) {
    lines.push(`  ${t.tool.padEnd(40)} ${String(t.calls).padStart(6)} calls  ${fmtNum(t.tokens_saved).padStart(12)} tok`);
  }
  lines.push("");
  lines.push("By reason");
  for (const r of s.by_reason) {
    lines.push(`  ${r.reason.padEnd(20)} ${String(r.calls).padStart(6)} calls  ${fmtNum(r.tokens_saved).padStart(12)} tok`);
  }
  lines.push("");
  if (s.by_day.length > 0) {
    lines.push("By day");
    for (const d of s.by_day) {
      const bar = "█".repeat(Math.min(40, Math.ceil((d.tokens_saved / (s.total_tokens_saved || 1)) * 40)));
      lines.push(`  ${d.day}  ${String(d.calls).padStart(6)} calls  ${fmtNum(d.tokens_saved).padStart(12)} tok  ${bar}`);
    }
  }
  return lines.join("\n") + "\n";
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderHtml = (s: ReportSummary): string => {
  const maxTok = s.by_day.reduce((m, d) => Math.max(m, d.tokens_saved), 0) || 1;
  const rows = (xs: { label: string; calls: number; tokens: number }[]): string =>
    xs
      .map(
        (x) =>
          `<tr><td>${escapeHtml(x.label)}</td><td class="n">${fmtNum(x.calls)}</td><td class="n">${fmtNum(
            x.tokens,
          )}</td></tr>`,
      )
      .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>Tokenomy Report</title>
<style>
  body { font: 13px/1.4 -apple-system, system-ui, sans-serif; margin: 2em; color: #222; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { color: #666; }
  table { border-collapse: collapse; margin: 12px 0; }
  th, td { text-align: left; padding: 4px 12px; border-bottom: 1px solid #eee; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .card { background: #fafafa; padding: 10px 16px; border-radius: 6px; margin: 12px 0; display: inline-block; }
  .bar { background: #0a7; height: 10px; border-radius: 2px; }
  .daygrid { display: grid; grid-template-columns: 140px 80px 140px 1fr; gap: 4px 12px; align-items: center; }
  .daygrid div.n { text-align: right; font-variant-numeric: tabular-nums; }
</style></head><body>
<h1>tokenomy report</h1>
<div class="sub">Window: ${escapeHtml(s.window.first_ts ?? "—")} → ${escapeHtml(s.window.last_ts ?? "—")}</div>
<div class="card"><strong>${fmtNum(s.total_calls)}</strong> events &nbsp;·&nbsp;
  <strong>${fmtNum(s.total_tokens_saved)}</strong> tokens saved &nbsp;·&nbsp;
  ~$${s.estimated_usd_saved.toFixed(4)} USD</div>

<h2>Top tools by tokens saved</h2>
<table><thead><tr><th>Tool</th><th>Calls</th><th>Tokens saved</th></tr></thead>
<tbody>${rows(s.by_tool.map((t) => ({ label: t.tool, calls: t.calls, tokens: t.tokens_saved })))}</tbody></table>

<h2>By reason</h2>
<table><thead><tr><th>Reason</th><th>Calls</th><th>Tokens saved</th></tr></thead>
<tbody>${rows(s.by_reason.map((r) => ({ label: r.reason, calls: r.calls, tokens: r.tokens_saved })))}</tbody></table>

<h2>By day</h2>
<div class="daygrid">
${s.by_day
    .map(
      (d) =>
        `<div>${escapeHtml(d.day)}</div><div class="n">${fmtNum(d.calls)}</div><div class="n">${fmtNum(
          d.tokens_saved,
        )}</div><div class="bar" style="width: ${Math.round((d.tokens_saved / maxTok) * 100)}%"></div>`,
    )
    .join("\n")}
</div>
</body></html>`;
};

const readConfigPrice = (): number => {
  if (!existsSync(globalConfigPath())) return DEFAULT_PRICE_PER_MILLION;
  const cfg = safeParse<Partial<Config> & { report?: { price_per_million?: number } }>(
    readFileSync(globalConfigPath(), "utf8"),
  );
  const v = cfg?.report?.price_per_million;
  return typeof v === "number" && v > 0 ? v : DEFAULT_PRICE_PER_MILLION;
};

export const runReport = (opts: ReportOptions): { summary: ReportSummary; htmlPath: string; tui: string } => {
  const logPath = defaultLogPath();
  const entries = readEntries(logPath, opts.since);
  const pricePerMillion = opts.pricePerMillion ?? readConfigPrice();
  const summary = summarize(entries, { top: opts.top, pricePerMillion });
  const html = renderHtml(summary);
  const tui = renderTui(summary);
  const htmlPath = opts.out ?? join(tokenomyDir(), "report.html");
  atomicWrite(htmlPath, html, false);
  return { summary, htmlPath, tui };
};

// Keep a handle on DEFAULT_CONFIG to avoid "unused import" noise from tsc
// when the report feature grows — the config schema already describes the
// default log path that drives this report.
export const _defaultLogPathForReport = (): string =>
  DEFAULT_CONFIG.log_path ?? defaultLogPath();
