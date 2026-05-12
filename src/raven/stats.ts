import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  legacyRavenRootDir,
  ravenRepoDir,
  type RepoIdentityLike,
  type StorageLocationConfig,
} from "../core/paths.js";
import { listProjects } from "../util/projects-registry.js";
import { loadConfig } from "../core/config.js";

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

  // Cross-repo aggregation via registry. 0.1.8+ codex round 1:
  // per-project we load its own config and tally the location it actually
  // uses (in-repo OR home). Pre-fix this only counted in-repo per project,
  // so a registered repo running in legacy `raven.location: "home"` mode
  // showed zero. Each project counted at most once.
  const countedRepoIds = new Set<string>();
  for (const project of listProjects()) {
    const identity = { repoId: project.repoId, repoPath: project.repoRoot };
    // Per-project location resolution. Caller can override with
    // `options.location` (uniform mode); otherwise load each project's
    // own `cfg.raven.location` and respect it. Defensive try/catch in
    // case a project's config is malformed.
    let perProjectCfg: StorageLocationConfig | undefined = options.location;
    if (!perProjectCfg) {
      try {
        perProjectCfg = loadConfig(project.repoRoot).raven;
      } catch {
        perProjectCfg = undefined;
      }
    }
    const dir = ravenRepoDir(identity, perProjectCfg);
    if (existsSync(dir)) {
      stats.repos++;
      countedRepoIds.add(project.repoId);
      const t = tallyRepoDir(stats, dir);
      if (t.latestMs > latestMs) latestMs = t.latestMs;
    }
  }
  // Cross-repo aggregation via legacy `~/.tokenomy/raven/<repoId>/` (best-
  // effort for unmigrated installs). Skip any repoId we already counted
  // above (regardless of how it was located).
  if (options.include_legacy !== false) {
    const legacyRoot = legacyRavenRootDir();
    if (existsSync(legacyRoot)) {
      for (const repoId of readdirSync(legacyRoot)) {
        if (countedRepoIds.has(repoId)) continue;
        const dir = join(legacyRoot, repoId);
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
