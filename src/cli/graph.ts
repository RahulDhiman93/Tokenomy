import { runGraphBuild } from "./graph-build.js";
import { runGraphPurge } from "./graph-purge.js";
import { runGraphQuery } from "./graph-query.js";
import { runGraphServe } from "./graph-serve.js";
import { runGraphStatus } from "./graph-status.js";

interface ArgMap {
  _: string[];
  flags: Record<string, string | boolean>;
}

const HELP = `Usage:
  tokenomy graph build [--force] [--path=<dir>]
  tokenomy graph status [--path=<dir>]
  tokenomy graph serve [--path=<dir>]
  tokenomy graph purge [--path=<dir>|--all]
  tokenomy graph query <minimal|impact|review> [--path=<dir>] ...
`;

const parseArgs = (argv: string[]): ArgMap => {
  const out: ArgMap = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.flags[a.slice(2)] = next;
        i++;
      } else {
        out.flags[a.slice(2)] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
};

export const runGraph = async (argv: string[]): Promise<number> => {
  const cmd = argv[0];

  if (!cmd) {
    process.stderr.write(HELP);
    return 1;
  }

  // `query` owns its own flag parsing (each sub-mode has different flags);
  // forward the raw argv so `--file` / `--files` survive the hop.
  if (cmd === "query") {
    // Pre-scan for --path only, don't eat anything else.
    const path = extractPath(argv.slice(1));
    return runGraphQuery({ cwd: process.cwd(), path, argv: argv.slice(1) });
  }

  const args = parseArgs(argv);
  const path = typeof args.flags["path"] === "string" ? args.flags["path"] : undefined;

  if (cmd === "build") {
    return runGraphBuild({ cwd: process.cwd(), path, force: args.flags["force"] === true });
  }
  if (cmd === "status") {
    return runGraphStatus({ cwd: process.cwd(), path });
  }
  if (cmd === "serve") {
    return runGraphServe({ cwd: process.cwd(), path });
  }
  if (cmd === "purge") {
    return runGraphPurge({ cwd: process.cwd(), path, all: args.flags["all"] === true });
  }

  process.stderr.write(`Unknown graph command: ${cmd}\n${HELP}`);
  return 1;
};

const extractPath = (argv: string[]): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--path") {
      const next = argv[i + 1];
      return typeof next === "string" && !next.startsWith("--") ? next : undefined;
    }
    if (a.startsWith("--path=")) return a.slice("--path=".length);
  }
  return undefined;
};
