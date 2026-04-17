#!/usr/bin/env node
import { runInit } from "./init.js";
import { runUninstall } from "./uninstall.js";
import { runDoctor } from "./doctor.js";
import { configGet, configSet } from "./config-cmd.js";
import { runGraph } from "./graph.js";
import type { Config } from "../core/types.js";
import { TOKENOMY_VERSION } from "../core/version.js";

const HELP = `tokenomy — transparent MCP tool-output trimmer for Claude Code

Usage:
  tokenomy init [--aggression=conservative|balanced|aggressive] [--no-backup] [--graph-path=<dir>]
  tokenomy doctor
  tokenomy graph build [--force] [--path=<dir>]
  tokenomy graph status [--path=<dir>]
  tokenomy graph serve [--path=<dir>]
  tokenomy graph purge [--path=<dir>|--all]
  tokenomy graph query <minimal|impact|review> ...
  tokenomy uninstall [--purge] [--no-backup]
  tokenomy config get <key>
  tokenomy config set <key> <value>
  tokenomy --version | --help
`;

interface ArgMap {
  _: string[];
  flags: Record<string, string | boolean>;
}

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

const isAggression = (v: string): v is Config["aggression"] =>
  v === "conservative" || v === "balanced" || v === "aggressive";

const printDoctor = async (): Promise<number> => {
  const results = await runDoctor();
  let failed = 0;
  for (const r of results) {
    const mark = r.ok ? "✓" : "✗";
    process.stdout.write(`${mark} ${r.name} — ${r.detail}\n`);
    if (!r.ok && r.remediation) process.stdout.write(`  → ${r.remediation}\n`);
    if (!r.ok) failed++;
  }
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
  return failed === 0 ? 0 : 1;
};

const main = async (): Promise<number> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags["version"] || args.flags["v"]) {
    process.stdout.write(`tokenomy ${TOKENOMY_VERSION}\n`);
    return 0;
  }
  if (args.flags["help"] || args.flags["h"] || args._.length === 0) {
    process.stdout.write(HELP);
    return args._.length === 0 ? 1 : 0;
  }

  const cmd = args._[0];

  if (cmd === "init") {
    const aggRaw = args.flags["aggression"];
    const aggression =
      typeof aggRaw === "string" && isAggression(aggRaw) ? aggRaw : undefined;
    const backup = args.flags["no-backup"] !== true;
    const graphPath =
      typeof args.flags["graph-path"] === "string" ? args.flags["graph-path"] : undefined;
    const result = runInit({ aggression, backup, graphPath });
    process.stdout.write(
      [
        `✓ Tokenomy installed`,
        `  hook:     ${result.hookPath}`,
        `  settings: ${result.settingsPath}`,
        `  backup:   ${result.backupPath ?? "(none)"}`,
        `  config:   ${result.configPath}`,
        ...(result.graphServerPath
          ? [`  graph:    tokenomy-graph -> ${result.graphServerPath}`]
          : []),
        `  manifest: ${result.manifestPath}`,
        `  Run: tokenomy doctor`,
        ``,
      ].join("\n"),
    );
    return 0;
  }

  if (cmd === "uninstall") {
    const purge = args.flags["purge"] === true;
    const backup = args.flags["no-backup"] !== true;
    const result = runUninstall({ purge, backup });
    process.stdout.write(
      [
        result.hooksRemoved ? `✓ Hook entries removed` : `• No hook entries found`,
        `  backup:   ${result.backupPath ?? "(none)"}`,
        result.purged ? `✓ ~/.tokenomy/ purged` : `• ~/.tokenomy/ kept (use --purge to remove)`,
        ``,
      ].join("\n"),
    );
    return 0;
  }

  if (cmd === "doctor") return printDoctor();
  if (cmd === "graph") return runGraph(process.argv.slice(3));

  if (cmd === "config") {
    const sub = args._[1];
    if (sub === "get" && args._[2]) {
      const v = configGet(args._[2]);
      process.stdout.write(v === undefined ? "" : `${JSON.stringify(v)}\n`);
      return 0;
    }
    if (sub === "set" && args._[2] !== undefined && args._[3] !== undefined) {
      configSet(args._[2], args._[3]);
      process.stdout.write(`✓ set ${args._[2]} = ${args._[3]}\n`);
      return 0;
    }
    process.stderr.write(`Usage: tokenomy config get <key> | set <key> <value>\n`);
    return 1;
  }

  process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
  return 1;
};

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    process.stderr.write(`tokenomy: ${(e as Error).message}\n`);
    process.exit(1);
  });
