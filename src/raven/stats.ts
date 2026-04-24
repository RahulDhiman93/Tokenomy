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

// Walk ~/.tokenomy/raven/<repo-id>/{packets,reviews,comparisons,decisions}
// and roll the JSON file counts into a single summary. Intentionally
// filesystem-driven rather than re-reading each JSON: callers only need
// counts + newest-mtime, so this stays O(files) with no parse cost.
export const collectRavenStats = (root = ravenRootDir(), enabled = false): RavenStats => {
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
  for (const repoId of readdirSync(root)) {
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
