import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../core/types.js";
import {
  graphDirtySentinelPath,
  graphRebuildStatsPath,
  type RepoIdentityLike,
} from "../core/paths.js";
import { safeParse } from "../util/json.js";
import { readDirtySentinel } from "./stale.js";

// 0.1.9+: shape surfaced by `tokenomy report` and `tokenomy analyze`.
// Sourced from `<graphDir>/.rebuild-stats.json` (rolling counters
// updated by the rebuild worker) and a live read of `.dirty`.
export interface GraphFreshnessStats {
  worker_active: boolean;
  rebuild_count: number;
  last_rebuild_ms: number;
  avg_rebuild_ms: number;
  last_rebuild_ts: string | null;
  dirty_files_pending: number;
  // Counters incremented by `dispatchGraphTool` when the query layer
  // intersects `stale_files` with the reachable surface. Hits = queries
  // where the scoped-stale flag was true; misses = whole-graph drift
  // existed but didn't intersect this query's surface (proves Fix 1's
  // value over time).
  stale_in_scope_hits: number;
  stale_in_scope_misses: number;
}

interface StoredStats {
  count?: number;
  last_ms?: number;
  total_ms?: number;
  last_ts?: string;
  worker_active?: boolean;
  stale_in_scope_hits?: number;
  stale_in_scope_misses?: number;
}

export const collectGraphFreshness = (
  identity: RepoIdentityLike,
  cfg: Config,
): GraphFreshnessStats => {
  const statsPath = graphRebuildStatsPath(identity, cfg.graph);
  const stored = existsSync(statsPath)
    ? (safeParse<StoredStats>(readFileSync(statsPath, "utf8")) ?? {})
    : {};
  const count = stored.count ?? 0;
  const totalMs = stored.total_ms ?? 0;
  const dirtyPath = graphDirtySentinelPath(identity, cfg.graph);
  let dirtyCount = 0;
  if (existsSync(dirtyPath)) {
    dirtyCount = readDirtySentinel(dirtyPath, identity.repoPath).files.length;
  }
  return {
    worker_active: stored.worker_active === true,
    rebuild_count: count,
    last_rebuild_ms: stored.last_ms ?? 0,
    avg_rebuild_ms: count > 0 ? totalMs / count : 0,
    last_rebuild_ts: stored.last_ts ?? null,
    dirty_files_pending: dirtyCount,
    stale_in_scope_hits: stored.stale_in_scope_hits ?? 0,
    stale_in_scope_misses: stored.stale_in_scope_misses ?? 0,
  };
};

// Public mutator used by handlers.ts to increment scoped-stale
// counters on every cacheable query response. Best-effort; never
// throws into the response path.
export const recordScopedStaleSample = (
  identity: RepoIdentityLike,
  cfg: Config,
  scopedHit: boolean,
): void => {
  try {
    const path = graphRebuildStatsPath(identity, cfg.graph);
    const stored = existsSync(path)
      ? (safeParse<StoredStats>(readFileSync(path, "utf8")) ?? {})
      : {};
    if (scopedHit) {
      stored.stale_in_scope_hits = (stored.stale_in_scope_hits ?? 0) + 1;
    } else {
      stored.stale_in_scope_misses = (stored.stale_in_scope_misses ?? 0) + 1;
    }
    // Inline write — these counters are O(1) and never read on the
    // hot read-side path (only at report time). Atomic rewrite is
    // overkill; one failed write costs one sample.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(stored));
  } catch {
    // best-effort
  }
};
