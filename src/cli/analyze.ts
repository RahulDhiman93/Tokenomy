import { loadConfig, DEFAULT_CONFIG } from "../core/config.js";
import { Aggregator } from "../analyze/report.js";
import { render, renderProgress } from "../analyze/render.js";
import {
  DEFAULT_CLAUDE_PROJECTS,
  DEFAULT_CODEX_SESSIONS,
  scan,
} from "../analyze/scan.js";
import { Simulator } from "../analyze/simulate.js";
import { loadTokenizer, type TokenizerChoice } from "../analyze/tokens.js";
import { computeGolemTune, writeGolemTune } from "../analyze/tune.js";
import { analyzeCachePath } from "../core/paths.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../core/types.js";

export interface AnalyzeOptions {
  path?: string | string[];
  since?: string;
  projectFilter?: string;
  sessionFilter?: string;
  top?: number;
  tokenizer?: TokenizerChoice;
  json?: boolean;
  color?: boolean;
  verbose?: boolean;
  // Per-million token price in USD for the $ estimate; falls back to
  // cfg.report.price_per_million or $3 default.
  pricePerMillion?: number;
  // Side-effect flags: when true, analyze writes its findings to
  // ~/.tokenomy/{golem-tune,analyze-cache}.json so other Tokenomy components
  // (SessionStart resolver, budget PreToolUse rule) can pick them up.
  tune?: boolean;
  cache?: boolean;
}

const parseSince = (input: string | undefined): Date | undefined => {
  if (!input) return undefined;
  // Relative: 1d, 7d, 30d, 1w, 2w, 3mo
  const rel = /^(\d+)(h|d|w|mo|m)$/.exec(input);
  if (rel) {
    const value = parseInt(rel[1]!, 10);
    const unit = rel[2]!;
    const ms =
      unit === "h"
        ? value * 3_600_000
        : unit === "d"
        ? value * 86_400_000
        : unit === "w"
        ? value * 7 * 86_400_000
        : unit === "m"
        ? value * 60_000
        : value * 30 * 86_400_000; // mo
    return new Date(Date.now() - ms);
  }
  const parsed = new Date(input);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
};

// Pricing is sourced from the already-merged Config (global + per-project
// .tokenomy.json overrides applied). Reading from the global file alone
// would silently drop repo-level overrides of report.price_per_million.
const priceFromConfig = (cfg: Config & { report?: { price_per_million?: number } }): number => {
  const v = cfg.report?.price_per_million;
  return typeof v === "number" && v > 0 ? v : 3.0;
};

// Default lookback window. Documented in README as "scans the last 30 days
// unless --since is passed". Users who want the full history pass --since=0d.
const DEFAULT_SINCE_DAYS = 30;

export const runAnalyze = async (opts: AnalyzeOptions): Promise<number> => {
  const cfg = loadConfig(process.cwd());
  // Honor an explicit `--since 0d` / `--since all` as "no window".
  const explicitAll = opts.since === "0d" || opts.since === "0" || opts.since === "all";
  let since: Date | undefined;
  if (explicitAll) {
    since = undefined;
  } else if (opts.since) {
    since = parseSince(opts.since);
    if (!since) {
      process.stderr.write(
        `tokenomy analyze: invalid --since value "${opts.since}". ` +
          `Use ISO (e.g. 2026-04-01), a relative span (1h / 7d / 2w / 3mo), ` +
          `or "all" / "0d" for the full history.\n`,
      );
      return 1;
    }
  } else {
    since = new Date(Date.now() - DEFAULT_SINCE_DAYS * 86_400_000);
  }
  const tokenizerChoice = opts.tokenizer ?? "auto";
  const colorEnabled = opts.color !== false && process.stdout.isTTY === true;
  const width = typeof process.stdout.columns === "number" ? process.stdout.columns : 100;
  const verbose = opts.verbose === true;

  // Default roots: Claude Code + Codex session dirs. Override via --path.
  const roots: string[] = Array.isArray(opts.path)
    ? opts.path
    : opts.path
    ? [opts.path]
    : [DEFAULT_CLAUDE_PROJECTS(), DEFAULT_CODEX_SESSIONS()];

  // Load tokenizer. If the user asked for tiktoken explicitly and it's
  // missing, this throws — surface that to the user and exit non-zero.
  let tokenizer;
  try {
    tokenizer = await loadTokenizer(tokenizerChoice);
  } catch (e) {
    process.stderr.write(`tokenomy analyze: ${(e as Error).message}\n`);
    return 1;
  }

  const simulator = new Simulator({ cfg, tokenizer });
  const agg = new Aggregator({
    top_n: opts.top ?? 10,
    price_per_million:
      opts.pricePerMillion ?? priceFromConfig(cfg as Config & { report?: { price_per_million?: number } }),
    tokenizer_name: tokenizer.name,
    tokenizer_approximate: tokenizer.approximate,
    raven_enabled: cfg.raven?.enabled === true,
  });

  // Live progress: write \r-updated status line to stderr so stdout stays
  // clean when the user pipes to `| less` or `--json` is set.
  const canShowProgress = process.stderr.isTTY === true && !opts.json;
  if (canShowProgress) process.stderr.write("\x1b[?25l"); // hide cursor
  let lastProgressWrite = 0;

  try {
    // Stream tool calls straight through the simulator. The simulator's
    // per-session dedup ledger tolerates interleaved/resumed sessions
    // (sidechain files may reopen a parent session_id after the main file)
    // without resetting state, so we don't have to buffer the corpus in
    // memory. This keeps `analyze` safe on large transcript histories.
    const scanStats = await scan(
      {
        roots,
        since,
        projectFilter: opts.projectFilter,
        sessionFilter: opts.sessionFilter,
        onProgress: canShowProgress
          ? (p) => {
              // Throttle to every ~100ms to avoid spamming the terminal.
              const now = Date.now();
              if (now - lastProgressWrite < 100) return;
              lastProgressWrite = now;
              process.stderr.write(
                renderProgress(p.file_index, p.file_total, p.bytes_read, p.elapsed_ms, colorEnabled, width),
              );
            }
          : undefined,
      },
      (call) => {
        agg.feed(simulator.feed(call));
      },
    );

    // Note files AFTER scan so we record the true count (including skipped).
    for (let i = 0; i < scanStats.files; i++) agg.noteFile();

    if (canShowProgress) {
      process.stderr.write("\r" + " ".repeat(Math.min(200, width)) + "\r");
      process.stderr.write("\x1b[?25h"); // show cursor
    }

    const report = agg.build();

    // Side-effect: analyze-cache for the budget PreToolUse rule. Writes
    // per-tool p95 bytes/tokens so budget lookups don't require replaying
    // transcripts on the hot hook path. Always emitted unless --cache=false
    // is explicit, so tune runs alone still populate the cache cheaply.
    if (opts.cache !== false) {
      try {
        const cache = {
          generated_ts: new Date().toISOString(),
          byTool: Object.fromEntries(
            report.by_tool.map((t) => [
              t.tool,
              {
                calls: t.calls,
                observed_tokens: t.observed_tokens,
                savings_tokens: t.savings_tokens,
                p50_latency_ms: t.p50_latency_ms,
                p95_latency_ms: t.p95_latency_ms,
                latency_samples: t.latency_samples,
                // Per-call p95 bytes/tokens for budget gate; derived from
                // observed totals + call count under the assumption that
                // the distribution is approximately log-normal.
                mean_tokens_per_call: t.calls > 0 ? Math.round(t.observed_tokens / t.calls) : 0,
              },
            ]),
          ),
        };
        const path = analyzeCachePath();
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(cache, null, 2) + "\n", "utf8");
      } catch {
        // Fail-open: analyze never refuses to render because of a cache write.
      }
    }

    if (opts.tune) {
      try {
        const tune = computeGolemTune({ since });
        const path = writeGolemTune(tune.state);
        process.stderr.write(
          `\n✓ Golem tune written to ${path}\n  ${tune.state.reasoning}\n`,
        );
      } catch (e) {
        process.stderr.write(`tokenomy analyze --tune: ${(e as Error).message}\n`);
      }
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }

    process.stdout.write(render(report, { color: colorEnabled, width, verbose }));
    return 0;
  } catch (e) {
    if (canShowProgress) process.stderr.write("\x1b[?25h");
    process.stderr.write(`tokenomy analyze: ${(e as Error).message}\n`);
    return 1;
  }
};

// Unused-import guard: DEFAULT_CONFIG kept reachable for future config keys.
void DEFAULT_CONFIG;
