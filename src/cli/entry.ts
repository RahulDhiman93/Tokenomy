#!/usr/bin/env node
import { runInit } from "./init.js";
import { runUninstall } from "./uninstall.js";
import { runDoctor, runDoctorFix } from "./doctor.js";
import { configGet, configSet } from "./config-cmd.js";
import { runGraph } from "./graph.js";
import { runReport } from "./report.js";
import { runAnalyze } from "./analyze.js";
import { runDiff } from "./diff.js";
import { runLearn } from "./learn.js";
import { runCi } from "./ci.js";
import { runRaven } from "./raven.js";
import { runUpdate } from "./update.js";
import { runGolem } from "./golem-cmd.js";
import { runCompress } from "./compress.js";
import { runStatusLine } from "./statusline.js";
import { runBenchCli } from "./bench.js";
import { agentNames, listAgentDetection } from "./agents/index.js";
import type { AgentName } from "./agents/common.js";
import { buildGraph } from "../graph/build.js";
import { loadConfig } from "../core/config.js";
import type { TokenizerChoice } from "../analyze/tokens.js";
import type { Config } from "../core/types.js";
import { TOKENOMY_VERSION } from "../core/version.js";

const HELP = `tokenomy — transparent MCP tool-output trimmer for Claude Code

Usage:
  tokenomy init [--aggression=conservative|balanced|aggressive] [--no-backup] [--graph-path=<dir>] [--no-build]
                [--agent=claude-code|codex|cursor|windsurf|cline|gemini] [--list-agents]
  tokenomy doctor [--fix]
  tokenomy status-line [--json]
  tokenomy compress <file> [--llm] [--dry-run] [--diff] [--in-place] [--force]
  tokenomy compress status | restore <file>
  tokenomy bench run [scenario] [--json]
  tokenomy bench compare <a.json> <b.json>
  tokenomy bench report --md
  tokenomy report [--since=<ISO>] [--top=<N>] [--out=<path>] [--json]
  tokenomy analyze [--path=<dir>] [--since=<ISO|Nd|Nw>] [--project=<str>] [--session=<id>]
                   [--top=<N>] [--tokenizer=heuristic|tiktoken|auto] [--json] [--no-color] [--verbose]
  tokenomy diff --call-key <sha256> | --tool <name> [--grep <str>] | --session <id> [--index <N>]
                [--since=<Nd|Nw|ISO>] [--tokenizer=heuristic|tiktoken|auto]
  tokenomy learn [--since=<Nd|Nw|ISO>] [--apply]
  tokenomy ci format --input=<analyze.json>
  tokenomy raven enable|disable|status|brief|compare|pr-check|clean|install-commands
  tokenomy graph build [--force] [--path=<dir>] [--exclude=<glob>...]
  tokenomy graph status [--path=<dir>]
  tokenomy graph serve [--path=<dir>]
  tokenomy graph purge [--path=<dir>|--all]
  tokenomy graph query <minimal|impact|review|usages> ...
  tokenomy uninstall [--purge] [--no-backup] [--agent=<name>]
  tokenomy update [--tag=alpha|latest|beta|rc] [--version=<v>] [--check] [--force]
  tokenomy config get <key>
  tokenomy config set <key> <value>
  tokenomy golem enable [--mode=lite|full|ultra|grunt]
  tokenomy golem disable
  tokenomy golem status
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

const isAgentName = (v: string): v is AgentName => (agentNames() as string[]).includes(v);

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

  // Accept `tokenomy update@<version>` as shorthand for the npm-style
  // invocation (e.g. `update@latest`, `update@0.1.0-alpha.12`). Split the
  // first positional into (cmd, inlineVersion) for downstream handlers.
  let cmd = args._[0];
  let inlineVersion: string | undefined;
  if (typeof cmd === "string" && cmd.startsWith("update@")) {
    inlineVersion = cmd.slice("update@".length);
    cmd = "update";
  }

  // Global --version / -v prints the CLI version and exits — but only when
  // no subcommand is present. Otherwise `tokenomy update --version=X` would
  // short-circuit here and never reach the update branch (Codex round-2).
  if ((args.flags["version"] || args.flags["v"]) && !cmd) {
    process.stdout.write(`tokenomy ${TOKENOMY_VERSION}\n`);
    return 0;
  }
  if (args.flags["help"] || args.flags["h"] || args._.length === 0) {
    process.stdout.write(HELP);
    return args._.length === 0 ? 1 : 0;
  }

  if (cmd === "init") {
    if (args.flags["list-agents"] === true) {
      for (const row of listAgentDetection()) {
        process.stdout.write(`${row.detected ? "✓" : "•"} ${row.agent}\t${row.detail}\n`);
      }
      return 0;
    }
    const aggRaw = args.flags["aggression"];
    const aggression =
      typeof aggRaw === "string" && isAggression(aggRaw) ? aggRaw : undefined;
    const backup = args.flags["no-backup"] !== true;
    const noBuild = args.flags["no-build"] === true;
    const graphPath =
      typeof args.flags["graph-path"] === "string" ? args.flags["graph-path"] : undefined;
    const agentRaw = typeof args.flags["agent"] === "string" ? args.flags["agent"] : undefined;
    if (agentRaw && !isAgentName(agentRaw)) {
      process.stderr.write(`tokenomy init: unknown --agent ${agentRaw}\n`);
      return 1;
    }
    const agent = agentRaw as AgentName | undefined;
    const result = runInit({ aggression, backup, graphPath, agent });

    // Auto-build the graph when --graph-path is set, unless --no-build opted out.
    // Runs after runInit so the config file (aggression, excludes, etc.) is
    // already persisted and loadConfig below picks up fresh values.
    let buildLine: string | null = null;
    if (result.graphServerPath && !noBuild) {
      try {
        const graphConfig = loadConfig(result.graphServerPath);
        const buildResult = await buildGraph({
          cwd: result.graphServerPath,
          config: graphConfig,
        });
        if (buildResult.ok) {
          const { node_count, edge_count, duration_ms, skipped_files } = buildResult.data;
          const skippedSuffix =
            skipped_files.length > 0 ? ` (${skipped_files.length} skipped)` : "";
          buildLine = `  build:    ${node_count} nodes / ${edge_count} edges in ${duration_ms}ms${skippedSuffix}`;
        } else {
          buildLine = `  build:    skipped (${buildResult.reason})`;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        buildLine = `  build:    skipped (${message})`;
      }
    }

    process.stdout.write(
      [
        `✓ Tokenomy installed`,
        `  hook:     ${result.hookPath ?? "(not installed for selected agent)"}`,
        `  settings: ${result.settingsPath ?? "(not patched for selected agent)"}`,
        `  backup:   ${result.backupPath ?? "(none)"}`,
        `  config:   ${result.configPath}`,
        ...(result.graphServerPath
          ? [`  graph:    tokenomy-graph -> ${result.graphServerPath}`]
          : []),
        ...result.agentResults.map((r) =>
          `  agent:    ${r.agent} ${r.installed ? "✓" : "skipped"} ${r.detail}`,
        ),
        ...(buildLine ? [buildLine] : []),
        `  manifest: ${result.manifestPath}`,
        `  Run: tokenomy doctor`,
        ``,
      ].join("\n"),
    );
    return 0;
  }

  if (cmd === "update") {
    // Reject bare value flags: `tokenomy update --version` (no value)
    // would otherwise silently fall back to the default `latest` target
    // and perform an unintended global update. parseArgs stores a bare
    // flag as `true`, so we detect that and fail fast with guidance.
    if (args.flags["version"] === true) {
      process.stderr.write(
        `tokenomy update: --version requires a value, e.g. --version=0.1.0-alpha.13 ` +
          `(or the shorthand \`tokenomy update@0.1.0-alpha.13\`).\n`,
      );
      return 1;
    }
    if (args.flags["tag"] === true) {
      process.stderr.write(
        `tokenomy update: --tag requires a value, e.g. --tag=latest (or alpha|beta|rc).\n`,
      );
      return 1;
    }
    const explicitVersion =
      typeof args.flags["version"] === "string" ? args.flags["version"] : undefined;
    // Precedence: --version flag > `update@X` shorthand > --tag flag > default
    const version = explicitVersion ?? inlineVersion;
    const tag = typeof args.flags["tag"] === "string" ? args.flags["tag"] : undefined;
    return runUpdate({
      tag,
      version,
      check: args.flags["check"] === true,
      force: args.flags["force"] === true,
    });
  }

  if (cmd === "uninstall") {
    const purge = args.flags["purge"] === true;
    const backup = args.flags["no-backup"] !== true;
    const agentRaw = typeof args.flags["agent"] === "string" ? args.flags["agent"] : undefined;
    if (agentRaw && !isAgentName(agentRaw)) {
      process.stderr.write(`tokenomy uninstall: unknown --agent ${agentRaw}\n`);
      return 1;
    }
    const agent = agentRaw as AgentName | undefined;
    const result = runUninstall({ purge, backup, agent });
    process.stdout.write(
      [
        result.hooksRemoved ? `✓ Hook entries removed` : `• No hook entries found`,
        ...(result.agentResult
          ? [`  agent:    ${result.agentResult.agent} ${result.agentResult.detail}`]
          : []),
        `  backup:   ${result.backupPath ?? "(none)"}`,
        result.purged ? `✓ ~/.tokenomy/ purged` : `• ~/.tokenomy/ kept (use --purge to remove)`,
        ``,
      ].join("\n"),
    );
    return 0;
  }

  if (cmd === "doctor") {
    if (args.flags["fix"]) {
      const applied = await runDoctorFix();
      for (const a of applied) process.stdout.write(`${a.ok ? "✓" : "✗"} ${a.name} — ${a.detail}\n`);
      return applied.every((a) => a.ok) ? 0 : 1;
    }
    return printDoctor();
  }
  if (cmd === "graph") return runGraph(process.argv.slice(3));

  if (cmd === "analyze") {
    const tokFlag = typeof args.flags["tokenizer"] === "string" ? (args.flags["tokenizer"] as string) : "auto";
    const tok: TokenizerChoice =
      tokFlag === "heuristic" || tokFlag === "tiktoken" || tokFlag === "auto" ? tokFlag : "auto";
    // Clamp --top to a sane positive integer: zero, negative, or non-numeric
    // input falls back to the default 10. This prevents the aggregator from
    // ever maintaining a zero-size outlier heap (which would blow up on
    // first access) and makes the behaviour predictable for typos.
    let topOpt: number | undefined;
    if (typeof args.flags["top"] === "string") {
      const parsed = parseInt(args.flags["top"], 10);
      if (Number.isFinite(parsed) && parsed > 0) topOpt = parsed;
      else {
        process.stderr.write(
          `tokenomy analyze: --top must be a positive integer (got ${JSON.stringify(args.flags["top"])}); using default 10.\n`,
        );
      }
    }
    return runAnalyze({
      path: typeof args.flags["path"] === "string" ? args.flags["path"] : undefined,
      since: typeof args.flags["since"] === "string" ? args.flags["since"] : undefined,
      projectFilter: typeof args.flags["project"] === "string" ? args.flags["project"] : undefined,
      sessionFilter: typeof args.flags["session"] === "string" ? args.flags["session"] : undefined,
      top: topOpt,
      tokenizer: tok,
      json: args.flags["json"] === true,
      color: args.flags["no-color"] !== true,
      verbose: args.flags["verbose"] === true,
      tune: args.flags["tune"] === true,
      cache: args.flags["no-cache"] !== true,
    });
  }

  if (cmd === "report") {
    const since =
      typeof args.flags["since"] === "string" ? new Date(args.flags["since"]) : undefined;
    const top = typeof args.flags["top"] === "string" ? parseInt(args.flags["top"], 10) : 10;
    const out = typeof args.flags["out"] === "string" ? args.flags["out"] : undefined;
    const price =
      typeof args.flags["price-per-million"] === "string"
        ? parseFloat(args.flags["price-per-million"])
        : undefined;
    const r = runReport({ since, top, out, pricePerMillion: price });
    if (args.flags["json"]) {
      process.stdout.write(JSON.stringify(r.summary, null, 2) + "\n");
    } else {
      process.stdout.write(r.tui);
      process.stdout.write(`\n✓ HTML report written to ${r.htmlPath}\n`);
    }
    return 0;
  }

  if (cmd === "diff") return runDiff(process.argv.slice(3));
  if (cmd === "learn") return runLearn(process.argv.slice(3));
  if (cmd === "ci") return runCi(process.argv.slice(3));
  if (cmd === "raven") return runRaven(process.argv.slice(3));
  if (cmd === "golem") return runGolem(process.argv.slice(3));
  if (cmd === "compress") return runCompress(process.argv.slice(3));
  if (cmd === "status-line") return runStatusLine(process.argv.slice(3));
  if (cmd === "bench") return runBenchCli(process.argv.slice(3));

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
