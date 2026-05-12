import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  legacyRavenRootDir,
  ravenRepoDir,
  type RepoIdentityLike,
  type StorageLocationConfig,
} from "../core/paths.js";
import { listProjects } from "../util/projects-registry.js";

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

const tallyRepoDir = (
  stats: RavenStats,
  repoDir: string,
): { latestMs: number } => {
  try {
    if (!statSync(repoDir).isDirectory()) return { latestMs: 0 };
  } catch {
    return { latestMs: 0 };
  }
  let latestMs = 0;
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
  return { latestMs };
};

export interface CollectRavenStatsOptions {
  // 0.1.8+: when set, restrict the rollup to ONE repo (in-repo storage at
  // the repo root, or legacy `~/.tokenomy/raven/<repoId>/`). Pre-0.1.8 this
  // took only `repoId` because all storage was under `~/.tokenomy/raven/`.
  identity?: RepoIdentityLike;
  // 0.1.8+: per-repo location config. Read from cfg.raven.
  location?: StorageLocationConfig;
  // 0.1.8+: when true (default), walk legacy `~/.tokenomy/raven/<*>/` too —
  // useful while users have a mix of migrated and non-migrated repos.
  include_legacy?: boolean;
}

// 0.1.8+: rolls up Raven stats from in-repo + legacy locations. When
// `options.identity` is set, scope to just that one repo. Otherwise walk
// the project registry for cross-repo aggregation.
export const collectRavenStats = (
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
  let latestMs = 0;

  // Scoped to one repo.
  if (options.identity) {
    const dir = ravenRepoDir(options.identity, options.location);
    if (existsSync(dir)) {
      stats.repos++;
      const t = tallyRepoDir(stats, dir);
      if (t.latestMs > latestMs) latestMs = t.latestMs;
    }
    // Also tally the legacy home location if asked.
    if (options.include_legacy !== false) {
      const legacyDir = join(legacyRavenRootDir(), options.identity.repoId);
      if (existsSync(legacyDir)) {
        if (!existsSync(dir)) stats.repos++; // avoid double-count when both exist
        const t = tallyRepoDir(stats, legacyDir);
        if (t.latestMs > latestMs) latestMs = t.latestMs;
      }
    }
    stats.last_activity = latestMs > 0 ? new Date(latestMs).toISOString() : null;
    return stats;
  }

  // Cross-repo aggregation via registry (in-repo).
  for (const project of listProjects()) {
    const identity = { repoId: project.repoId, repoPath: project.repoRoot };
    const dir = ravenRepoDir(identity, options.location);
    if (!existsSync(dir)) continue;
    stats.repos++;
    const t = tallyRepoDir(stats, dir);
    if (t.latestMs > latestMs) latestMs = t.latestMs;
  }
  // Cross-repo aggregation via legacy `~/.tokenomy/raven/<repoId>/` (best-
  // effort for unmigrated installs).
  if (options.include_legacy !== false) {
    const legacyRoot = legacyRavenRootDir();
    if (existsSync(legacyRoot)) {
      for (const repoId of readdirSync(legacyRoot)) {
        const dir = join(legacyRoot, repoId);
        // Skip if already counted via registry+in-repo above (same repoId).
        const alreadyCounted = listProjects().some((p) => p.repoId === repoId);
        if (alreadyCounted) continue;
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        stats.repos++;
        const t = tallyRepoDir(stats, dir);
        if (t.latestMs > latestMs) latestMs = t.latestMs;
      }
    }
  }
  stats.last_activity = latestMs > 0 ? new Date(latestMs).toISOString() : null;
  return stats;
};
