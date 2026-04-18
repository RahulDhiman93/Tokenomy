import { readFileSync, existsSync } from "node:fs";
import { loadConfig, DEFAULT_CONFIG } from "../core/config.js";
import { globalConfigPath } from "../core/paths.js";
import { safeParse } from "../util/json.js";
import { Aggregator } from "../analyze/report.js";
import { render, renderProgress } from "../analyze/render.js";
import {
  DEFAULT_CLAUDE_PROJECTS,
  DEFAULT_CODEX_SESSIONS,
  scan,
} from "../analyze/scan.js";
import { Simulator } from "../analyze/simulate.js";
import { loadTokenizer, type TokenizerChoice } from "../analyze/tokens.js";
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

const readPricePerMillion = (): number => {
  if (!existsSync(globalConfigPath())) return 3.0;
  const cfg = safeParse<Partial<Config> & { report?: { price_per_million?: number } }>(
    readFileSync(globalConfigPath(), "utf8"),
  );
  const v = cfg?.report?.price_per_million;
  return typeof v === "number" && v > 0 ? v : 3.0;
};

export const runAnalyze = async (opts: AnalyzeOptions): Promise<number> => {
  const cfg = loadConfig(process.cwd());
  const since = parseSince(opts.since);
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
    price_per_million: readPricePerMillion(),
    tokenizer_name: tokenizer.name,
    tokenizer_approximate: tokenizer.approximate,
  });

  // Live progress: write \r-updated status line to stderr so stdout stays
  // clean when the user pipes to `| less` or `--json` is set.
  const canShowProgress = process.stderr.isTTY === true && !opts.json;
  if (canShowProgress) process.stderr.write("\x1b[?25l"); // hide cursor
  let lastProgressWrite = 0;

  try {
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
