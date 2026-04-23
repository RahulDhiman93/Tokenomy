import { existsSync, readFileSync } from "node:fs";
import { renderBenchMarkdown, runBench } from "../bench/runner.js";

const usage = `Usage:
  tokenomy bench run [scenario] [--json]
  tokenomy bench compare <a.json> <b.json>
  tokenomy bench report --md [scenario]
`;

export const runBenchCli = (argv: string[]): number => {
  const sub = argv[0];
  if (!sub || sub === "help") {
    process.stdout.write(usage);
    return sub ? 0 : 1;
  }
  if (sub === "run") {
    const scenario = argv.find((arg, idx) => idx > 0 && !arg.startsWith("--"));
    const run = runBench(scenario);
    if (argv.includes("--json")) process.stdout.write(JSON.stringify(run, null, 2) + "\n");
    else process.stdout.write(renderBenchMarkdown(run));
    return 0;
  }
  if (sub === "report") {
    const scenario = argv.find((arg, idx) => idx > 0 && !arg.startsWith("--"));
    process.stdout.write(renderBenchMarkdown(runBench(scenario)));
    return 0;
  }
  if (sub === "compare") {
    const a = argv[1];
    const b = argv[2];
    if (!a || !b || !existsSync(a) || !existsSync(b)) {
      process.stderr.write(usage);
      return 1;
    }
    const before = JSON.parse(readFileSync(a, "utf8")) as { total_tokens_saved?: number };
    const after = JSON.parse(readFileSync(b, "utf8")) as { total_tokens_saved?: number };
    const delta = (after.total_tokens_saved ?? 0) - (before.total_tokens_saved ?? 0);
    process.stdout.write(`tokens_saved_delta: ${delta >= 0 ? "+" : ""}${delta}\n`);
    return 0;
  }
  process.stderr.write(usage);
  return 1;
};

