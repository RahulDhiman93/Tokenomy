import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ravenRootDir } from "../core/paths.js";

export interface RavenStats {
  enabled: boolean;
  packets: number;
  reviews: number;
  comparisons: number;
  decisions: number;
  repos: number;
  last_activity: string | null;
}

const countJsonFiles = (dir: string): { count: number; latestMs: number } => {
  if (!existsSync(dir)) return { count: 0, latestMs: 0 };
  let count = 0;
  let latestMs = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    count++;
    try {
      const ms = statSync(join(dir, name)).mtimeMs;
      if (ms > latestMs) latestMs = ms;
    } catch {
      // Racing with cleanStore — skip the file.
    }
  }
  return { count, latestMs };
};

export interface CollectRavenStatsOptions {
  // 0.1.3+: scope the rollup to a single repo_id. When set, only that
  // subdirectory is walked. When undefined (default), aggregate across
  // every registered Raven repo — preserves the historical "global"
  // behavior that `tokenomy report --all-repos` continues to use.
  repoId?: string;
}

// Walk ~/.tokenomy/raven/<repo-id>/{packets,reviews,comparisons,decisions}
// and roll the JSON file counts into a single summary. Intentionally
// filesystem-driven rather than re-reading each JSON: callers only need
// counts + newest-mtime, so this stays O(files) with no parse cost.
export const collectRavenStats = (
  root: string = ravenRootDir(),
  enabled = false,
  options: CollectRavenStatsOptions = {},
): RavenStats => {
  const stats: RavenStats = {
    enabled,
    packets: 0,
    reviews: 0,
    comparisons: 0,
    decisions: 0,
    repos: 0,
    last_activity: null,
  };
  if (!existsSync(root)) return stats;
  let latestMs = 0;
  // 0.1.3+: when scoped to a single repoId, walk just that dir. Avoids
  // rolling up cross-repo Raven activity into the agent's report — that
  // inflated counters and cost tokens explaining "100 packets" when the
  // current repo only had 2.
  const repoIds = options.repoId
    ? existsSync(join(root, options.repoId))
      ? [options.repoId]
      : []
    : readdirSync(root);
  for (const repoId of repoIds) {
    const repoDir = join(root, repoId);
    try {
      if (!statSync(repoDir).isDirectory()) continue;
    } catch {
      continue;
    }
    stats.repos++;
    for (const [sub, field] of [
      ["packets", "packets"],
      ["reviews", "reviews"],
      ["comparisons", "comparisons"],
      ["decisions", "decisions"],
    ] as const) {
      const { count, latestMs: ms } = countJsonFiles(join(repoDir, sub));
      stats[field] += count;
      if (ms > latestMs) latestMs = ms;
    }
  }
  stats.last_activity = latestMs > 0 ? new Date(latestMs).toISOString() : null;
  return stats;
};
