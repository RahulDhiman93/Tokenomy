import type { AggregateReport } from "./report.js";

// Pure stdlib ANSI. No chalk, no boxen, no ora.
// Colours are disabled automatically when stdout isn't a TTY or when the
// caller passes {color: false}.

export interface RenderOptions {
  color: boolean;
  width: number; // terminal width (columns), capped to a sane max.
  verbose: boolean;
}

const ansi = (on: boolean) => ({
  reset: on ? "\x1b[0m" : "",
  bold: on ? "\x1b[1m" : "",
  dim: on ? "\x1b[2m" : "",
  red: on ? "\x1b[31m" : "",
  green: on ? "\x1b[32m" : "",
  yellow: on ? "\x1b[33m" : "",
  blue: on ? "\x1b[34m" : "",
  magenta: on ? "\x1b[35m" : "",
  cyan: on ? "\x1b[36m" : "",
  gray: on ? "\x1b[90m" : "",
  bgGreen: on ? "\x1b[42m" : "",
});

const n = (v: number): string => v.toLocaleString("en-US");

const pad = (s: string, width: number, align: "l" | "r" = "l"): string => {
  // ANSI-aware length: strip control codes before measuring.
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length >= width) return s;
  const filler = " ".repeat(width - visible.length);
  return align === "l" ? s + filler : filler + s;
};

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

const sparkline = (values: number[]): string => {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)))])
    .join("");
};

const bar = (fraction: number, width: number): string => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
};

const boxTop = (width: number, title: string, c: ReturnType<typeof ansi>): string => {
  const plain = ` ${title} `;
  const fill = Math.max(0, width - plain.length - 2);
  return `${c.cyan}╭${"─".repeat(Math.floor(fill / 2))}${c.bold}${plain}${c.reset}${c.cyan}${"─".repeat(Math.ceil(fill / 2))}╮${c.reset}`;
};
const boxBottom = (width: number, c: ReturnType<typeof ansi>): string =>
  `${c.cyan}╰${"─".repeat(Math.max(0, width - 2))}╯${c.reset}`;
const boxLine = (width: number, inner: string, c: ReturnType<typeof ansi>): string => {
  const visible = inner.replace(/\x1b\[[0-9;]*m/g, "");
  const padCount = Math.max(0, width - 2 - visible.length);
  return `${c.cyan}│${c.reset}${inner}${" ".repeat(padCount)}${c.cyan}│${c.reset}`;
};

const RULE_LABEL: Record<string, string> = {
  dedup: "Duplicate-response dedup",
  stacktrace: "Stacktrace collapse",
  profile: "Schema-aware profile trim",
  mcp_trim: "Byte head+tail trim",
  read_clamp: "Read clamp",
};

// Render a progress line that overwrites itself via \r. Caller should emit
// a trailing \n when the scan completes.
export const renderProgress = (
  file_index: number,
  file_total: number,
  bytes_read: number,
  elapsed_ms: number,
  color: boolean,
  width: number,
): string => {
  const c = ansi(color);
  const pct = file_total > 0 ? file_index / file_total : 1;
  const barWidth = Math.max(8, Math.min(30, width - 60));
  const mbs = bytes_read / Math.max(1, elapsed_ms) / 1000;
  const eta = pct > 0 && pct < 1 ? ` ETA ${Math.round((elapsed_ms / pct - elapsed_ms) / 1000)}s` : "";
  const line =
    `${c.dim}Scanning${c.reset} ` +
    `${c.bold}${String(file_index).padStart(String(file_total).length)}${c.reset}/` +
    `${file_total}  ` +
    `${c.green}${bar(pct, barWidth)}${c.reset}  ` +
    `${(pct * 100).toFixed(1)}%  ${mbs.toFixed(1)} MB/s${eta}`;
  return `\r${line.slice(0, width + 40)}`; // allow extra for ansi codes
};

export const render = (report: AggregateReport, opts: RenderOptions): string => {
  const c = ansi(opts.color);
  const width = Math.min(120, Math.max(60, opts.width));
  const out: string[] = [];

  // Header box.
  out.push(boxTop(width, "tokenomy analyze", c));
  const window =
    report.window.first_ts && report.window.last_ts
      ? `${report.window.first_ts.slice(0, 19)}Z  →  ${report.window.last_ts.slice(0, 19)}Z`
      : "(no events)";
  out.push(boxLine(width, ` ${c.dim}Window:${c.reset} ${window}`, c));
  out.push(
    boxLine(
      width,
      ` ${c.dim}Tokenizer:${c.reset} ${c.bold}${report.tokenizer.name}${c.reset} ${report.tokenizer.approximate ? c.dim + "(approximate)" + c.reset : c.green + "(accurate)" + c.reset}`,
      c,
    ),
  );
  out.push(boxBottom(width, c));
  out.push("");

  // Totals card.
  const t = report.totals;
  const wastePct = t.observed_tokens > 0 ? (t.savings_tokens / t.observed_tokens) * 100 : 0;
  out.push(`${c.bold}Summary${c.reset}`);
  out.push(
    `  ${pad("Files scanned", 26)} ${c.bold}${n(t.files)}${c.reset}` +
      `     ${pad("Sessions", 14)} ${c.bold}${n(t.sessions)}${c.reset}`,
  );
  out.push(
    `  ${pad("Tool calls parsed", 26)} ${c.bold}${n(t.tool_calls)}${c.reset}` +
      `     ${pad("Duplicate calls", 14)} ${c.bold}${n(t.duplicate_calls)}${c.reset}`,
  );
  out.push(
    `  ${pad("Tokens observed", 26)} ${c.bold}${n(t.observed_tokens)}${c.reset}` +
      `     ${pad("~USD observed", 14)} ${c.bold}$${t.estimated_usd_observed.toFixed(4)}${c.reset}`,
  );
  out.push(
    `  ${pad("Tokens Tokenomy would save", 26)} ` +
      `${c.green}${c.bold}${n(t.savings_tokens)}${c.reset} ` +
      `${c.dim}(${wastePct.toFixed(1)}% of observed)${c.reset}`,
  );
  out.push(
    `  ${pad("~USD Tokenomy would save", 26)} ${c.green}${c.bold}$${t.estimated_usd_saved.toFixed(4)}${c.reset}`,
  );
  if (t.redact_matches > 0) {
    out.push(
      `  ${c.yellow}⚠${c.reset}  ${pad("Secret-pattern matches", 26)} ${c.yellow}${c.bold}${n(t.redact_matches)}${c.reset} ${c.dim}(redaction would fire)${c.reset}`,
    );
  }
  out.push("");

  // Per-rule breakdown.
  out.push(`${c.bold}Savings by rule${c.reset}`);
  if (report.by_rule.length === 0) {
    out.push(`  ${c.dim}(no rule fires — either no events or nothing to trim)${c.reset}`);
  } else {
    const maxR = Math.max(...report.by_rule.map((r) => r.savings_tokens), 1);
    for (const r of report.by_rule) {
      const label = RULE_LABEL[r.rule] ?? r.rule;
      const frac = r.savings_tokens / maxR;
      out.push(
        `  ${pad(label, 30)} ${c.green}${bar(frac, 24)}${c.reset} ` +
          `${c.bold}${pad(n(r.savings_tokens), 10, "r")}${c.reset} tok ` +
          `${c.dim}(${n(r.events)} events)${c.reset}`,
      );
    }
  }
  out.push("");

  // Top tools.
  out.push(`${c.bold}Top tools by observed token waste${c.reset}`);
  if (report.by_tool.length === 0) {
    out.push(`  ${c.dim}(no tool activity)${c.reset}`);
  } else {
    const maxT = Math.max(...report.by_tool.map((t2) => t2.observed_tokens), 1);
    const header =
      `  ${pad("Tool", 40)}  ${pad("Calls", 7, "r")}  ${pad("Observed", 12, "r")}  ` +
      `${pad("Saveable", 12, "r")}  ${pad("%", 5, "r")}  ${pad("Bar", 20)}`;
    out.push(c.dim + header + c.reset);
    for (const row of report.by_tool) {
      const frac = row.observed_tokens / maxT;
      const waste = row.waste_pct * 100;
      const colourLabel =
        waste >= 50
          ? c.red + row.tool + c.reset
          : waste >= 20
          ? c.yellow + row.tool + c.reset
          : row.tool;
      out.push(
        `  ${pad(colourLabel, 40)}  ` +
          `${pad(n(row.calls), 7, "r")}  ` +
          `${pad(n(row.observed_tokens), 12, "r")}  ` +
          `${c.green}${pad(n(row.savings_tokens), 12, "r")}${c.reset}  ` +
          `${pad(waste.toFixed(0) + "%", 5, "r")}  ` +
          `${c.cyan}${bar(frac, 20)}${c.reset}`,
      );
    }
  }
  out.push("");

  // Duplicate hotspots.
  if (report.hotspots.length > 0) {
    out.push(`${c.bold}Duplicate hotspots${c.reset}  ${c.dim}(same args, repeated within a session)${c.reset}`);
    for (const h of report.hotspots) {
      out.push(
        `  ${pad(h.tool, 40)}  ${pad(n(h.calls) + "×", 7, "r")}  ` +
          `${c.red}${pad(n(h.wasted_tokens), 12, "r")}${c.reset} tok wasted`,
      );
    }
    out.push("");
  }

  // Outliers.
  if (report.outliers.length > 0) {
    out.push(`${c.bold}Largest individual tool results${c.reset}`);
    for (const o of report.outliers) {
      out.push(
        `  ${pad(o.tool, 40)}  ${pad(n(o.tokens), 10, "r")} tok  ` +
          `${c.dim}${o.ts.slice(0, 19)}  ${o.session_id.slice(0, 8)}${c.reset}`,
      );
    }
    out.push("");
  }

  // By-day sparkline.
  if (report.by_day.length > 1) {
    out.push(`${c.bold}By day${c.reset}  ${c.dim}(observed tokens)${c.reset}`);
    const values = report.by_day.map((d) => d.observed_tokens);
    out.push(
      `  ${c.cyan}${sparkline(values)}${c.reset}  ` +
        `${c.dim}${report.by_day[0]!.day} → ${report.by_day[report.by_day.length - 1]!.day}${c.reset}`,
    );
    if (opts.verbose) {
      for (const d of report.by_day) {
        const frac = d.observed_tokens / Math.max(1, ...values);
        out.push(
          `  ${d.day}  ${c.cyan}${bar(frac, 20)}${c.reset}  ` +
            `${pad(n(d.observed_tokens), 10, "r")} observed  ` +
            `${c.green}${pad(n(d.savings_tokens), 10, "r")}${c.reset} saveable`,
        );
      }
    }
    out.push("");
  }

  return out.join("\n") + "\n";
};
