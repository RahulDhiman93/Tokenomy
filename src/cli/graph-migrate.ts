import { migrateAll } from "../util/migrate-storage.js";

// 0.1.8+: `tokenomy graph migrate [--apply]` — walks the project registry
// and relocates legacy `~/.tokenomy/graphs/<repoId>/` snapshots into the
// new in-repo `<repoRoot>/.tokenomy-graph/` location.
//
// Default is a dry-run that prints the plan; pass `--apply` to perform
// the moves. Best-effort per repo — a single failure doesn't abort the
// run. Reports success / skip / fail counts.
export const runGraphMigrate = async (opts: { apply: boolean }): Promise<number> => {
  const results = migrateAll("graph", opts.apply);
  if (results.length === 0) {
    process.stdout.write(
      "No projects registered. Run `tokenomy graph build --path \"$PWD\"` in each repo first, then retry.\n",
    );
    return 0;
  }
  let moved = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "moved") moved++;
    else if (r.status === "failed") failed++;
    else skipped++;
    process.stdout.write(
      `  ${r.status.padEnd(20)} ${r.from} → ${r.to}${r.reason ? ` (${r.reason})` : ""}\n`,
    );
  }
  process.stdout.write(
    `\n${opts.apply ? "Migrated" : "Would migrate"}: ${moved} moved, ${skipped} skipped, ${failed} failed.\n`,
  );
  if (!opts.apply) {
    process.stdout.write("Re-run with --apply to perform the moves.\n");
  }
  return failed > 0 ? 1 : 0;
};
