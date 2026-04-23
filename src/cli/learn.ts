import { mineProposals } from "../analyze/miner.js";
import { applyProposals } from "../core/config-writer.js";

const parseSince = (s: string | undefined): Date | undefined => {
  if (!s) return undefined;
  const m = /^(\d+)([dwh])$/.exec(s);
  if (m) {
    const n = parseInt(m[1]!, 10);
    const mult = m[2] === "d" ? 86_400_000 : m[2] === "w" ? 7 * 86_400_000 : 3_600_000;
    return new Date(Date.now() - n * mult);
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t) : undefined;
};

export const runLearn = (argv: string[]): number => {
  let apply = false;
  let since: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a?.startsWith("--since=")) since = a.slice("--since=".length);
    else if (a === "--since") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        since = v;
        i++;
      }
    }
  }
  const sinceDate = parseSince(since);
  const proposals = mineProposals(sinceDate);
  if (proposals.length === 0) {
    process.stdout.write("tokenomy learn: no proposals — nothing to tune.\n");
    return 0;
  }
  process.stdout.write(
    `tokenomy learn: ${proposals.length} proposal${proposals.length === 1 ? "" : "s"}\n\n`,
  );
  for (const p of proposals) {
    process.stdout.write(`${p.id}\n`);
    process.stdout.write(`  rationale: ${p.rationale}\n`);
    process.stdout.write(`  evidence:  ${p.evidence}\n`);
    const opLabel = p.patch.op === "append" ? "+= " : "= ";
    process.stdout.write(`  patch:     ${p.patch.path} ${opLabel}${JSON.stringify(p.patch.value)}\n\n`);
  }
  if (!apply) {
    process.stdout.write("Run `tokenomy learn --apply` to write these into ~/.tokenomy/config.json (a backup is kept).\n");
    return 0;
  }
  const result = applyProposals(proposals.map((p) => p.patch));
  process.stdout.write(
    `✓ Applied ${result.applied} patch${result.applied === 1 ? "" : "es"} to ${result.config_path}\n` +
      `  backup: ${result.backup_path}\n`,
  );
  return 0;
};
