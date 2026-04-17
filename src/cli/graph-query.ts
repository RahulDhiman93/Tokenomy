import { loadConfig } from "../core/config.js";
import { stableStringify } from "../util/json.js";
import { impactRadius } from "../graph/query/impact.js";
import { loadGraphContext } from "../graph/query/common.js";
import { minimalContext } from "../graph/query/minimal.js";
import { reviewContext } from "../graph/query/review.js";

const parseIntegerFlag = (
  value: string | boolean | undefined,
  fallback: number,
): number => {
  if (typeof value !== "string") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseCsv = (value: string | boolean | undefined): string[] =>
  typeof value === "string"
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];

const parseFlags = (argv: string[]): Record<string, string | boolean> => {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === undefined) continue;
    if (!current.startsWith("--")) continue;
    const eq = current.indexOf("=");
    if (eq !== -1) {
      flags[current.slice(2, eq)] = current.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[current.slice(2)] = next;
      i++;
    } else {
      flags[current.slice(2)] = true;
    }
  }
  return flags;
};

const print = (value: unknown): number => {
  process.stdout.write(`${stableStringify(value)}\n`);
  return value && typeof value === "object" && (value as { ok?: boolean }).ok === false ? 1 : 0;
};

export const runGraphQuery = async (opts: {
  cwd: string;
  path?: string;
  argv: string[];
}): Promise<number> => {
  const mode = opts.argv[0];
  const flags = parseFlags(opts.argv.slice(1));
  const target = opts.path ?? opts.cwd;
  const config = loadConfig(target);
  const context = loadGraphContext(target, config);
  if (!context.ok) return print(context);

  if (mode === "minimal") {
    const file = typeof flags["file"] === "string" ? flags["file"] : undefined;
    if (!file) return print({ ok: false, reason: "invalid-input", hint: "Pass --file=<path>." });
    return print(
      minimalContext(
        context.data.graph,
        {
          target: {
            file,
            ...(typeof flags["symbol"] === "string" ? { symbol: flags["symbol"] } : {}),
          },
          depth: parseIntegerFlag(flags["depth"], 1),
        },
        config,
        context.data.stale,
        context.data.stale_files,
      ),
    );
  }

  if (mode === "impact") {
    const file = typeof flags["file"] === "string" ? flags["file"] : undefined;
    if (!file) return print({ ok: false, reason: "invalid-input", hint: "Pass --file=<path>." });
    return print(
      impactRadius(
        context.data.graph,
        {
          changed: [
            {
              file,
              ...(parseCsv(flags["symbols"]).length > 0
                ? { symbols: parseCsv(flags["symbols"]) }
                : {}),
            },
          ],
          max_depth: parseIntegerFlag(flags["max-depth"], 2),
        },
        config,
        context.data.stale,
        context.data.stale_files,
      ),
    );
  }

  if (mode === "review") {
    const files = parseCsv(flags["files"]);
    if (files.length === 0) {
      return print({
        ok: false,
        reason: "invalid-input",
        hint: "Pass --files=a.ts,b.ts.",
      });
    }
    return print(
      reviewContext(
        context.data.graph,
        { files },
        config,
        context.data.stale,
        context.data.stale_files,
      ),
    );
  }

  return print({
    ok: false,
    reason: "invalid-input",
    hint: "Use `minimal`, `impact`, or `review`.",
  });
};
