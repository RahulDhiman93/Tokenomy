import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../core/types.js";
import {
  graphDirtySentinelPath,
  graphRebuildStatsLogPath,
  graphRebuildStatsPath,
  type RepoIdentityLike,
} from "../core/paths.js";
import { safeParse } from "../util/json.js";
import { atomicWrite } from "../util/atomic.js";
import { readDirtySentinel } from "./stale.js";

// 0.1.9+: shape surfaced by `tokenomy report` and `tokenomy analyze`.
// Sourced from `<graphDir>/.rebuild-stats.json` (snapshot) + the
// `<graphDir>/.rebuild-stats.log` NDJSON delta tail (0.1.10+).
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

export interface StoredStats {
  count: number;
  last_ms: number;
  total_ms: number;
  last_ts: string;
  worker_active: boolean;
  stale_in_scope_hits: number;
  stale_in_scope_misses: number;
}

interface StoredDelta {
  ts: string;
  delta: Partial<StoredStats>;
}

const emptyStats = (): StoredStats => ({
  count: 0,
  last_ms: 0,
  total_ms: 0,
  last_ts: "",
  worker_active: false,
  stale_in_scope_hits: 0,
  stale_in_scope_misses: 0,
});

const readSnapshot = (path: string): StoredStats => {
  const acc = emptyStats();
  if (!existsSync(path)) return acc;
  const parsed = safeParse<Partial<StoredStats>>(readFileSync(path, "utf8"));
  if (!parsed) return acc;
  if (typeof parsed.count === "number") acc.count = parsed.count;
  if (typeof parsed.last_ms === "number") acc.last_ms = parsed.last_ms;
  if (typeof parsed.total_ms === "number") acc.total_ms = parsed.total_ms;
  if (typeof parsed.last_ts === "string") acc.last_ts = parsed.last_ts;
  if (typeof parsed.worker_active === "boolean") acc.worker_active = parsed.worker_active;
  if (typeof parsed.stale_in_scope_hits === "number") {
    acc.stale_in_scope_hits = parsed.stale_in_scope_hits;
  }
  if (typeof parsed.stale_in_scope_misses === "number") {
    acc.stale_in_scope_misses = parsed.stale_in_scope_misses;
  }
  return acc;
};

// Fold one delta line onto the accumulator. Numeric counters sum;
// "last_*" / worker_active fields use last-writer-wins ordering
// (caller iterates the log file top to bottom).
const applyDelta = (acc: StoredStats, d: Partial<StoredStats>): void => {
  if (typeof d.count === "number") acc.count += d.count;
  if (typeof d.total_ms === "number") acc.total_ms += d.total_ms;
  if (typeof d.last_ms === "number") acc.last_ms = d.last_ms;
  if (typeof d.last_ts === "string") acc.last_ts = d.last_ts;
  if (typeof d.worker_active === "boolean") acc.worker_active = d.worker_active;
  if (typeof d.stale_in_scope_hits === "number") {
    acc.stale_in_scope_hits += d.stale_in_scope_hits;
  }
  if (typeof d.stale_in_scope_misses === "number") {
    acc.stale_in_scope_misses += d.stale_in_scope_misses;
  }
};

export const readFoldedStats = (
  identity: RepoIdentityLike,
  cfg: Config,
): StoredStats => {
  const acc = readSnapshot(graphRebuildStatsPath(identity, cfg.graph));
  const logPath = graphRebuildStatsLogPath(identity, cfg.graph);
  if (!existsSync(logPath)) return acc;
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return acc;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const parsed = safeParse<StoredDelta>(line);
    if (!parsed || !parsed.delta || typeof parsed.delta !== "object") continue;
    applyDelta(acc, parsed.delta);
  }
  return acc;
};

const appendDelta = (logPath: string, delta: Partial<StoredStats>): void => {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    const line = `${JSON.stringify({ ts: new Date().toISOString(), delta })}\n`;
    // appendFileSync with a single short write is atomic on POSIX for
    // sizes < PIPE_BUF (typically 4KB). Our lines are ~150 bytes —
    // well under the threshold — so concurrent writers don't interleave.
    appendFileSync(logPath, line);
  } catch {
    // best-effort
  }
};

const STATS_LOG_COMPACT_THRESHOLD = 1_048_576; // 1MB

// Called from postBuildSuccess after a successful rebuild. Folds the
// log into the snapshot and truncates the log so the read path stays
// cheap. Best-effort — failure leaves the log in place and the next
// read still works (it just folds more deltas).
export const maybeCompactRebuildStats = (
  identity: RepoIdentityLike,
  cfg: Config,
): void => {
  const logPath = graphRebuildStatsLogPath(identity, cfg.graph);
  let size = 0;
  try {
    size = statSync(logPath).size;
  } catch {
    return;
  }
  if (size < STATS_LOG_COMPACT_THRESHOLD) return;
  try {
    const folded = readFoldedStats(identity, cfg);
    const snapshotPath = graphRebuildStatsPath(identity, cfg.graph);
    atomicWrite(snapshotPath, JSON.stringify(folded), false);
    unlinkSync(logPath);
  } catch {
    // best-effort
  }
};

export const collectGraphFreshness = (
  identity: RepoIdentityLike,
  cfg: Config,
): GraphFreshnessStats => {
  const folded = readFoldedStats(identity, cfg);
  const dirtyPath = graphDirtySentinelPath(identity, cfg.graph);
  let dirtyCount = 0;
  if (existsSync(dirtyPath)) {
    dirtyCount = readDirtySentinel(dirtyPath, identity.repoPath).files.length;
  }
  return {
    worker_active: folded.worker_active,
    rebuild_count: folded.count,
    last_rebuild_ms: folded.last_ms,
    avg_rebuild_ms: folded.count > 0 ? folded.total_ms / folded.count : 0,
    last_rebuild_ts: folded.last_ts.length > 0 ? folded.last_ts : null,
    dirty_files_pending: dirtyCount,
    stale_in_scope_hits: folded.stale_in_scope_hits,
    stale_in_scope_misses: folded.stale_in_scope_misses,
  };
};

// Public mutator used by handlers.ts to increment scoped-stale
// counters on every cacheable query response. Now atomic across
// concurrent MCP queries (P10e).
export const recordScopedStaleSample = (
  identity: RepoIdentityLike,
  cfg: Config,
  scopedHit: boolean,
): void => {
  const logPath = graphRebuildStatsLogPath(identity, cfg.graph);
  if (scopedHit) {
    appendDelta(logPath, { stale_in_scope_hits: 1 });
  } else {
    appendDelta(logPath, { stale_in_scope_misses: 1 });
  }
};

// Worker-side mutator. Appended after a successful rebuild.
export const recordRebuildDelta = (
  identity: RepoIdentityLike,
  cfg: Config,
  duration_ms: number,
): void => {
  const logPath = graphRebuildStatsLogPath(identity, cfg.graph);
  appendDelta(logPath, {
    count: 1,
    last_ms: duration_ms,
    total_ms: duration_ms,
    last_ts: new Date().toISOString(),
    worker_active: true,
  });
};

// Worker-side mutator. Appended on shutdown / drop.
export const recordWorkerInactiveDelta = (
  identity: RepoIdentityLike,
  cfg: Config,
): void => {
  const logPath = graphRebuildStatsLogPath(identity, cfg.graph);
  appendDelta(logPath, { worker_active: false });
};
