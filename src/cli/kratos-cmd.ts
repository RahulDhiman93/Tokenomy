import { configSet } from "./config-cmd.js";
import { loadConfig } from "../core/config.js";
import { formatKratosScan, runKratosScan } from "../kratos/scan.js";
import { evaluatePrompt } from "../kratos/prompt-rule.js";

// `tokenomy kratos enable|disable|status|scan|check`
//
// enable/disable/status: thin wrappers over `tokenomy config set kratos.*`.
// scan: full audit of installed agent configs (Claude / Codex / Cursor /
//       Windsurf / Cline / Gemini) — read-only, no side effects.
// check <prompt>: dry-run the prompt-time rule against an arbitrary string.
//                 Useful for testing before enabling continuous mode.

const writeStatus = (): number => {
  const cfg = loadConfig(process.cwd());
  const k = cfg.kratos;
  process.stdout.write(`Kratos: ${k.enabled ? "ENABLED" : "disabled"}\n`);
  process.stdout.write(`  continuous:           ${k.continuous}\n`);
  process.stdout.write(`  prompt_min_severity:  ${k.prompt_min_severity}\n`);
  process.stdout.write(`  notice_max_bytes:     ${k.notice_max_bytes}\n`);
  process.stdout.write(`  categories:\n`);
  for (const [cat, on] of Object.entries(k.categories)) {
    process.stdout.write(`    ${cat.padEnd(24)} ${on ? "on" : "off"}\n`);
  }
  if (!k.enabled) {
    process.stdout.write("\nRun `tokenomy kratos enable` to turn it on.\n");
  } else if (!k.continuous) {
    process.stdout.write(
      "\nContinuous mode is OFF — kratos only runs when invoked via `tokenomy kratos scan`.\n",
    );
  }
  return 0;
};

const runScan = (argv: string[]): number => {
  const cfg = loadConfig(process.cwd());
  const json = argv.includes("--json");
  const report = runKratosScan(cfg.log_path);
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(formatKratosScan(report) + "\n");
  }
  // Exit code 1 when ANY high/critical finding exists so `tokenomy kratos
  // scan` can be wired into CI without parsing JSON. info/medium are
  // advisory and don't fail the run.
  return report.counts.critical + report.counts.high > 0 ? 1 : 0;
};

const runCheck = (argv: string[]): number => {
  const cfg = loadConfig(process.cwd());
  const prompt = argv.join(" ");
  if (prompt.length === 0) {
    process.stderr.write("usage: tokenomy kratos check <prompt text>\n");
    return 2;
  }
  // Force continuous=true for the duration of this check so the user can
  // dry-run the rule even if they haven't enabled it yet.
  const dryCfg = {
    ...cfg,
    kratos: { ...cfg.kratos, enabled: true, continuous: true },
  };
  const result = evaluatePrompt(prompt, dryCfg);
  if (!result.flagged) {
    process.stdout.write("✓ No findings.\n");
    return 0;
  }
  for (const f of result.findings) {
    process.stdout.write(
      `[${f.severity.toUpperCase()}/${f.confidence}] ${f.category} — ${f.title}\n`,
    );
    process.stdout.write(`  ${f.detail}\n`);
    if (f.evidence) process.stdout.write(`  evidence: ${f.evidence}\n`);
    if (f.fix) process.stdout.write(`  fix: ${f.fix}\n`);
    process.stdout.write("\n");
  }
  return result.findings.some((f) => f.severity === "critical" || f.severity === "high") ? 1 : 0;
};

export const runKratos = (argv: string[]): number => {
  const sub = argv[0];

  if (sub === "status" || sub === undefined) return writeStatus();

  if (sub === "enable") {
    configSet("kratos.enabled", "true");
    process.stdout.write(
      "✓ Kratos enabled. Continuous prompt-time scan is on by default.\n" +
        "  → `tokenomy kratos status` shows current categories + thresholds.\n" +
        "  → `tokenomy kratos scan` audits installed MCP servers + hooks.\n",
    );
    return 0;
  }

  if (sub === "disable") {
    configSet("kratos.enabled", "false");
    process.stdout.write("✓ Kratos disabled. Prompt scan + scan command stay quiet.\n");
    return 0;
  }

  if (sub === "scan") return runScan(argv.slice(1));
  if (sub === "check") return runCheck(argv.slice(1));

  process.stderr.write(
    "Usage:\n" +
      "  tokenomy kratos enable\n" +
      "  tokenomy kratos disable\n" +
      "  tokenomy kratos status\n" +
      "  tokenomy kratos scan [--json]\n" +
      "  tokenomy kratos check <prompt text>\n",
  );
  return 1;
};
