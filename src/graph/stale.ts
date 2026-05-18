import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { Config } from "../core/types.js";
import { graphDirtySentinelPath, graphRebuildLockPath, graphSnapshotPath } from "../core/paths.js";
import type { GraphMeta } from "./schema.js";
import {
  enumerateAllFiles,
  enumerateGraphFiles,
  enumerateGraphFilesFromRaw,
} from "./enumerate.js";
import { fingerprintExcludes } from "./exclude-fingerprint.js";
import { computeTsconfigFingerprint } from "./tsconfig-fingerprint.js";
import { sha256FileSync } from "./hash.js";
import { resolveRepoId } from "./repo-id.js";
import { JsonGraphStore } from "./store.js";
import type { FailOpen } from "./types.js";

export interface StaleStatus {
  ok: true;
  stale: boolean;
  stale_files: string[];
}

export type GraphStaleResult = StaleStatus | FailOpen;

// 0.1.10+ equal-mtime defense (P10b): when mtime matches the recorded
// value, also require size + inode match if meta carries them.
// `touch -r` restores mtime without changing content, but inode or
// size of a modified file will differ. Pre-0.1.10 meta lacks
// file_sizes/file_inos — caller falls back to mtime-only behavior.
export const fileLooksUnchanged = (
  meta: GraphMeta,
  file: string,
  st: { ino: number; mtimeMs: number; size: number },
): boolean => {
  if (meta.file_mtimes[file] !== st.mtimeMs) return false;
  if (meta.file_sizes !== undefined && meta.file_sizes[file] !== undefined) {
    if (meta.file_sizes[file] !== st.size) return false;
  }
  if (meta.file_inos !== undefined && meta.file_inos[file] !== undefined) {
    if (meta.file_inos[file] !== st.ino) return false;
  }
  return true;
};

// codex round 8 P2: helper used by the sentinel fast path to merge
// hook-recorded edits with out-of-band drift (git checkout, external
// editor, Bash codegen). Walks every file tracked in meta.file_mtimes;
// O(tracked files) but no SHA reads — just statSync.
//
// codex round 10 P2: cache the result keyed on sentinel
// (inode + size + mtime) AND meta.built_at. Repeated queries within
// a burst reuse the cached drift list instead of re-walking on every
// request.
//
// codex round 12 P2: TTL the cache. The sentinel-only key misses
// out-of-band edits to tracked files (the sentinel doesn't grow
// because it's only written by the PostToolUse hook). A short TTL
// re-walks recently enough that `git checkout`/codegen drift is
// caught within the window, while still amortizing tight burst-read
// loops common in interactive agent sessions.
const DRIFT_CACHE_TTL_MS = 750;
// 0.1.10+ P10f: periodic sweep interval. Drift caches are queried by
// repoPath; a user working across N repos leaves N entries that only
// got TTL-checked on a hit-for-that-same-repo. Sweep every 5s so cold
// entries don't leak across the process lifetime.
const DRIFT_CACHE_SWEEP_INTERVAL_MS = 5000;
interface DriftCacheEntry {
  ino: number;
  size: number;
  mtimeMs: number;
  built_at: string;
  files: string[];
  computed_at: number;
}
const driftCacheByRepo = new Map<string, DriftCacheEntry>();

const mtimeDriftFiles = (
  repoPath: string,
  meta: import("./schema.js").GraphMeta,
  sentinelStat?: { ino: number; size: number; mtimeMs: number },
): string[] => {
  if (sentinelStat) {
    const cached = driftCacheByRepo.get(repoPath);
    if (
      cached &&
      cached.ino === sentinelStat.ino &&
      cached.size === sentinelStat.size &&
      cached.mtimeMs === sentinelStat.mtimeMs &&
      cached.built_at === meta.built_at &&
      performance.now() - cached.computed_at <= DRIFT_CACHE_TTL_MS
    ) {
      return cached.files;
    }
  }
  const drift: string[] = [];
  for (const file of Object.keys(meta.file_mtimes)) {
    const abs = join(repoPath, ...file.split("/"));
    let st: { ino: number; mtimeMs: number; size: number };
    try {
      const s = statSync(abs);
      st = { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      drift.push(file);
      continue;
    }
    if (!fileLooksUnchanged(meta, file, st)) drift.push(file);
  }
  if (sentinelStat) {
    driftCacheByRepo.set(repoPath, {
      ino: sentinelStat.ino,
      size: sentinelStat.size,
      mtimeMs: sentinelStat.mtimeMs,
      built_at: meta.built_at,
      files: drift,
      computed_at: performance.now(),
    });
    ensureSweepTimer();
  }
  return drift;
};

// codex round 11 P2: enumerate the current graph file set and
// return files NOT in the snapshot's file_hashes. Cached with the
// same sentinel-stat key as `mtimeDriftFiles` to avoid double-walks.
interface AddedCacheEntry {
  ino: number;
  size: number;
  mtimeMs: number;
  built_at: string;
  files: string[];
  computed_at: number;
}
const addedCacheByRepo = new Map<string, AddedCacheEntry>();

const addedFilesSince = (
  repoPath: string,
  cfg: Config,
  meta: import("./schema.js").GraphMeta,
  sentinelStat?: { ino: number; size: number; mtimeMs: number },
): string[] => {
  if (sentinelStat) {
    const cached = addedCacheByRepo.get(repoPath);
    if (
      cached &&
      cached.ino === sentinelStat.ino &&
      cached.size === sentinelStat.size &&
      cached.mtimeMs === sentinelStat.mtimeMs &&
      cached.built_at === meta.built_at &&
      performance.now() - cached.computed_at <= DRIFT_CACHE_TTL_MS
    ) {
      return cached.files;
    }
  }
  const enumerated = enumerateGraphFiles(repoPath, cfg);
  if (!enumerated.ok) return [];
  const previous = new Set(Object.keys(meta.file_hashes));
  const added: string[] = [];
  for (const f of enumerated.files) if (!previous.has(f)) added.push(f);
  if (sentinelStat) {
    addedCacheByRepo.set(repoPath, {
      ino: sentinelStat.ino,
      size: sentinelStat.size,
      mtimeMs: sentinelStat.mtimeMs,
      built_at: meta.built_at,
      files: added,
      computed_at: performance.now(),
    });
    ensureSweepTimer();
  }
  return added;
};

// codex round 12 P2: TTL-cached tsconfig fingerprint. Same shape +
// TTL as the drift/added caches so burst reads while the sentinel
// sits don't repeatedly enumerate the repo or parse tsconfig files.
interface TsconfigFpCacheEntry {
  ino: number;
  size: number;
  mtimeMs: number;
  built_at: string;
  fingerprint: string;
  computed_at: number;
}
const tsconfigFpCacheByRepo = new Map<string, TsconfigFpCacheEntry>();

const cachedTsconfigFingerprint = (
  repoPath: string,
  meta: import("./schema.js").GraphMeta,
  cfg: Config,
  sentinelStat?: { ino: number; size: number; mtimeMs: number },
): string => {
  if (sentinelStat) {
    const cached = tsconfigFpCacheByRepo.get(repoPath);
    if (
      cached &&
      cached.ino === sentinelStat.ino &&
      cached.size === sentinelStat.size &&
      cached.mtimeMs === sentinelStat.mtimeMs &&
      cached.built_at === meta.built_at &&
      performance.now() - cached.computed_at <= DRIFT_CACHE_TTL_MS
    ) {
      return cached.fingerprint;
    }
  }
  const raw = enumerateAllFiles(repoPath);
  const fp = computeTsconfigFingerprint(repoPath, raw.files, cfg.graph.tsconfig.enabled);
  if (sentinelStat) {
    tsconfigFpCacheByRepo.set(repoPath, {
      ino: sentinelStat.ino,
      size: sentinelStat.size,
      mtimeMs: sentinelStat.mtimeMs,
      built_at: meta.built_at,
      fingerprint: fp,
      computed_at: performance.now(),
    });
    ensureSweepTimer();
  }
  return fp;
};

// 0.1.10+ P10f: periodic sweep. Lazy-init on first cache write so a
// short-lived CLI invocation (no caches touched → no timer) doesn't pay
// the cost. The timer is `.unref()` so it doesn't keep the process
// alive past natural exit.
let sweepTimer: NodeJS.Timeout | null = null;
const ensureSweepTimer = (): void => {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    const now = performance.now();
    const stale = (computed_at: number): boolean =>
      now - computed_at > DRIFT_CACHE_TTL_MS * 4;
    for (const [k, v] of driftCacheByRepo) {
      if (stale(v.computed_at)) driftCacheByRepo.delete(k);
    }
    for (const [k, v] of addedCacheByRepo) {
      if (stale(v.computed_at)) addedCacheByRepo.delete(k);
    }
    for (const [k, v] of tsconfigFpCacheByRepo) {
      if (stale(v.computed_at)) tsconfigFpCacheByRepo.delete(k);
    }
    if (
      driftCacheByRepo.size === 0 &&
      addedCacheByRepo.size === 0 &&
      tsconfigFpCacheByRepo.size === 0 &&
      sweepTimer !== null
    ) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, DRIFT_CACHE_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
};

// Test affordance — clear between tests so per-repo cache doesn't bleed.
export const _resetDriftCacheForTests = (): void => {
  driftCacheByRepo.clear();
  addedCacheByRepo.clear();
  tsconfigFpCacheByRepo.clear();
  if (sweepTimer !== null) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
};

export interface CheapStaleStatus {
  missing: boolean;
  stale: boolean;
  stale_files: string[];
  // 0.1.9+: time since the earliest unconsumed entry in the dirty
  // sentinel. Populated when the sentinel exists; null otherwise.
  // Read-side handler uses this to surface rebuild lag to callers.
  lag_ms?: number | null;
}

// 0.1.9+: parse `<graphDir>/.dirty` content. Sentinel format is
// `<iso>\t<file_path>\n` per line, append-only across PostToolUse fires.
// Returns sorted, deduped list of file paths. Best-effort: malformed
// lines and missing files yield an empty list (caller falls back to the
// full mtime walk so we never silently report "stale_files: []").
//
// 0.1.9+ codex round 1 P2: when `repoPath` is supplied, normalize each
// path to a repo-relative form so the scoped-stale intersection works.
// PostToolUse payloads can carry absolute `file_path` (Claude Code does
// when the agent operates on absolute paths); graph nodes are always
// repo-relative. Without normalization the intersection misses the
// edited file, queries report `stale: false` while a real edit is
// pending, and Fix 1 silently regresses.
export const readDirtySentinel = (
  path: string,
  repoPath?: string,
): { files: string[]; oldest_ts: number | null } => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { files: [], oldest_ts: null };
  }
  const files = new Set<string>();
  let oldest = Number.POSITIVE_INFINITY;
  // 0.1.10+ P10c: detect drive-letter paths regardless of process
  // platform. On POSIX, `isAbsolute("C:\\repo\\src\\a.ts")` returns
  // false, so a Windows-written sentinel read on POSIX would fall
  // through to relative-path handling and emit a corrupt key.
  const isWindowsDriveAbs = (p: string): boolean => /^[A-Za-z]:[/\\]/.test(p);
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const ts = Date.parse(line.slice(0, tab));
    let file = line.slice(tab + 1).trim();
    if (!file) continue;
    if (isWindowsDriveAbs(file)) {
      // Sentinel line is a Windows absolute path. On a POSIX reader
      // there's no meaningful mapping to repo-relative; drop it. On
      // Windows the OS-native isAbsolute would have caught it below,
      // but treating it explicitly keeps the path through normalize.
      if (sep === "/") continue;
      if (!repoPath) continue;
      const rel = relative(repoPath, file);
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      file = rel;
    } else if (isAbsolute(file)) {
      if (!repoPath) {
        // No repo context to anchor against — best to drop than to
        // produce a path that never matches a graph node.
        continue;
      }
      const rel = relative(repoPath, file);
      // `relative` returns "../..." when the file is OUTSIDE repoPath.
      if (rel.startsWith("..") || isAbsolute(rel)) continue;
      file = rel;
    }
    // codex round 3 P3: normalize relative paths too. Hook payloads
    // sometimes carry "./src/a.ts" (Claude Code occasionally), and
    // on Windows the separator inside a relative path is "\". Graph
    // node ids are always plain forward-slash repo-relative.
    if (sep !== "/") file = file.split(sep).join("/");
    if (file.startsWith("./")) file = file.slice(2);
    while (file.startsWith("/")) file = file.slice(1);
    if (Number.isFinite(ts) && ts < oldest) oldest = ts;
    files.add(file);
  }
  return {
    files: [...files].sort(),
    oldest_ts: oldest === Number.POSITIVE_INFINITY ? null : oldest,
  };
};

export const getGraphStaleStatus = (
  repoPath: string,
  meta: GraphMeta,
  cfg: Config,
): GraphStaleResult => {
  // A change to the exclude set (or an older meta that predates fingerprinting)
  // invalidates the whole graph: we can't diff without reparsing, so force a
  // rebuild instead of returning a silently-wrong cached graph.
  if (meta.exclude_fingerprint !== fingerprintExcludes(cfg.graph.exclude)) {
    return { ok: true, stale: true, stale_files: [] };
  }

  // Share one raw walk between tsconfig fingerprint + graph-file enumeration.
  const raw = enumerateAllFiles(repoPath);

  // A change to any tsconfig/jsconfig `paths` (or an extends-chain base) OR
  // a toggle of `graph.tsconfig.enabled` rewires imports in ways we can't
  // diff per-file. Invalidate the whole graph. The fingerprint helper uses
  // a sentinel when disabled so toggling true↔false always mismatches.
  if (
    meta.tsconfig_fingerprint !==
    computeTsconfigFingerprint(repoPath, raw.files, cfg.graph.tsconfig.enabled)
  ) {
    return { ok: true, stale: true, stale_files: [] };
  }

  const enumerated = enumerateGraphFilesFromRaw(repoPath, cfg, raw);
  if (!enumerated.ok) return enumerated;

  const current = new Set(enumerated.files);
  const previous = new Set(Object.keys(meta.file_hashes));
  const stale = new Set<string>();

  for (const file of current) {
    if (!previous.has(file)) stale.add(file);
  }
  for (const file of previous) {
    if (!current.has(file)) stale.add(file);
  }

  for (const file of current) {
    if (!previous.has(file)) continue;
    const absPath = join(repoPath, ...file.split("/"));
    if (!existsSync(absPath)) {
      stale.add(file);
      continue;
    }
    let st: { ino: number; mtimeMs: number; size: number };
    try {
      const s = statSync(absPath);
      st = { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      stale.add(file);
      continue;
    }
    if (fileLooksUnchanged(meta, file, st)) continue;
    if (meta.file_hashes[file] !== sha256FileSync(absPath)) stale.add(file);
  }

  const stale_files = [...stale].sort();
  return { ok: true, stale: stale_files.length > 0, stale_files };
};

// Cheap stale check for the MCP read-side auto-refresh path. Loads meta only
// (no snapshot JSON) and compares mtimes without SHA-256 hashing. Designed to
// run before every read-side graph query: if this says fresh, we skip the
// full buildGraph({force:false}) call and its snapshot parse.
//
// Semantics on `stale:true` outputs:
//   - meta missing (graph never built): { missing: true, stale: true, stale_files: [] }
//   - exclude fingerprint changed: { stale: true, stale_files: [] }
//   - mtime mismatch on any file, or an added/removed file: populated list
// Callers that observe stale:true should invoke buildGraph({force:false}) —
// buildGraph does the SHA-256 verification before actually rebuilding, so a
// false-positive mtime bump (e.g. from `touch`) still short-circuits cheaply.
export const isGraphStaleCheap = (
  cwd: string,
  cfg: Config,
): CheapStaleStatus => {
  const identity = resolveRepoId(cwd);
  const store = new JsonGraphStore();
  const meta = store.loadMeta(identity, cfg.graph);
  if (!meta) return { missing: true, stale: true, stale_files: [] };
  // meta.json alone isn't enough — the read-side query also needs the graph
  // snapshot. If it's been deleted (or never written), treat as missing so
  // ensureFreshGraph triggers a rebuild instead of letting downstream queries
  // fail with graph-not-built.
  if (!existsSync(graphSnapshotPath(identity, cfg.graph))) {
    return { missing: true, stale: true, stale_files: [] };
  }

  // 0.1.3 fast path: PostToolUse on Edit/Write/MultiEdit appends to a
  // `<graphDir>/.dirty` log. 0.1.9+: we parse it so callers (query layer
  // + statusline + worker) see the actual per-edit file paths rather
  // than an opaque "something changed" flag. The full SHA verification
  // still happens at rebuild time, so a false-positive touch (mtime
  // bumped, content unchanged) collapses cheaply downstream.
  const sentinelPath = graphDirtySentinelPath(identity, cfg.graph);
  // 0.1.10+ P10d round-2 (codex P2): treat a zero-byte sentinel as
  // "no drift". Pre-fix, the foreign-user EPERM truncate fallback
  // left an empty .dirty in place — existsSync returned true and
  // every read flagged stale → perpetual rebuild loop. An empty
  // sentinel carries no entries; the parsed.files would be []
  // anyway. Skip the whole fast-path in that case.
  let sentinelSize = -1;
  try {
    sentinelSize = existsSync(sentinelPath) ? statSync(sentinelPath).size : -1;
  } catch {
    sentinelSize = -1;
  }
  if (sentinelSize > 0) {
    const parsed = readDirtySentinel(sentinelPath, identity.repoPath);
    // codex round 6 P3: lag_ms must distinguish "sentinel exists"
    // from "no sentinel". If oldest_ts isn't parseable (legacy
    // marker, missing tab), fall back to the sentinel file's mtime
    // so the handler still sees sentinel-driven staleness and
    // delegates to the worker instead of competing.
    let lag_ms: number | null;
    if (parsed.oldest_ts) {
      lag_ms = Math.max(0, Date.now() - parsed.oldest_ts);
    } else {
      try {
        lag_ms = Math.max(0, Date.now() - statSync(sentinelPath).mtimeMs);
      } catch {
        lag_ms = 0;
      }
    }
    // codex round 6 P2: dirty entries that change the GRAPH BUILD
    // ITSELF (tsconfig.json / jsconfig.json / .tokenomy.json change
    // path aliases or excludes) must be reported as whole-graph
    // stale, not granular. The query layer's scoped-stale
    // intersection would otherwise see e.g. `tsconfig.json` in the
    // list, find no graph node for it, and report
    // `stale_in_scope: []` even though every node potentially moved.
    const wholeGraphTriggers = parsed.files.some((f) =>
      /(^|\/)tsconfig.*\.json$/i.test(f) ||
      /(^|\/)jsconfig.*\.json$/i.test(f) ||
      /(^|\/)\.tokenomy\.json$/.test(f),
    );
    // codex round 7 P2 / round 8 P2: also check fingerprints. Pre-
    // fix, the read path passes the sentinel's granular list into
    // `loadGraphContext` with `skipStaleCheck:true`, so out-of-band
    // changes (git checkout, manual edit, codegen via Bash) to
    // tsconfig/jsconfig/.tokenomy.json or any exclude pattern would
    // never be detected — every query reports `stale_in_scope: []`
    // for files outside the reachable surface, but the whole graph
    // is actually invalid.
    //
    // Exclude check is O(1) (just stringify of cfg.graph.exclude).
    // Tsconfig check requires `enumerateAllFiles` — O(repo). We pay
    // that once per sentinel-active query; the queryCache amortizes
    // repeated queries on the same snapshot.
    const excludeChanged =
      meta.exclude_fingerprint !== fingerprintExcludes(cfg.graph.exclude);
    let tsconfigChanged = false;
    if (!excludeChanged && !wholeGraphTriggers && parsed.files.length > 0) {
      try {
        // codex round 12 P2: cache the tsconfig fingerprint with
        // the same sentinel-stat + TTL key. Pre-fix, every
        // cacheable read while `.dirty` was pending paid for an
        // `enumerateAllFiles` + tsconfig parse — that defeated the
        // worker's low-latency read path on large repos.
        let st: { ino: number; size: number; mtimeMs: number } | undefined;
        try {
          const s = statSync(sentinelPath);
          st = { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          // best-effort
        }
        const fp = cachedTsconfigFingerprint(identity.repoPath, meta, cfg, st);
        if (fp !== meta.tsconfig_fingerprint) tsconfigChanged = true;
      } catch {
        // best-effort; treat as no-change rather than failing the read.
      }
    }
    if (wholeGraphTriggers || excludeChanged || tsconfigChanged) {
      // codex round 6 P2 / round 7 P2: whole-graph invalidation
      // (config file changed, or fingerprint mismatch). Signal
      // with empty stale_files; scopeStale honors the input stale
      // flag.
      return { missing: false, stale: true, stale_files: [], lag_ms };
    }
    if (parsed.files.length > 0) {
      // codex round 8 P2 / round 11 P2: ALSO run the mtime walk
      // AND enumerate current files so we catch:
      //   - out-of-band edits (git checkout, external editor, Bash
      //     codegen) to files already tracked by the snapshot.
      //   - NEWLY ADDED files (git checkout brought in a new
      //     source file). `meta.file_mtimes` is from the prior
      //     snapshot, so a fresh file isn't in there — only an
      //     enumerate against the current disk state can find it.
      //
      // codex round 10 P2: cache keyed on sentinel ino+size+mtime
      // so repeated queries while the sentinel sits don't re-walk
      // every tracked file. First query while the sentinel is
      // active pays O(tracked files + enumerate); subsequent reads
      // reuse the cached drift list until the sentinel grows OR
      // the snapshot is rebuilt.
      let sentinelStat: { ino: number; size: number; mtimeMs: number } | undefined;
      try {
        const st = statSync(sentinelPath);
        sentinelStat = { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        // best-effort
      }
      const merged = new Set<string>(parsed.files);
      try {
        const drift = mtimeDriftFiles(identity.repoPath, meta, sentinelStat);
        for (const f of drift) merged.add(f);
      } catch {
        // best-effort
      }
      // codex round 11 P2: enumerate to find ADDED files (present
      // on disk, absent from the snapshot's file_hashes). Same
      // cache key — added-files set is stable as long as the
      // sentinel and snapshot are unchanged.
      try {
        const added = addedFilesSince(identity.repoPath, cfg, meta, sentinelStat);
        for (const f of added) merged.add(f);
      } catch {
        // best-effort
      }
      return {
        missing: false,
        stale: true,
        stale_files: [...merged].sort(),
        lag_ms,
      };
    }
    // codex round 4 P2 / round 6 P2: sentinel exists but parses
    // empty (legacy marker, truncated mid-write, malformed).
    // Pre-0.1.9 behavior was to treat any sentinel as stale; we
    // preserve that with empty stale_files, which signals
    // "whole-graph stale" to the query layer via the input stale
    // flag.
    return { missing: false, stale: true, stale_files: [], lag_ms };
  }

  if (meta.exclude_fingerprint !== fingerprintExcludes(cfg.graph.exclude)) {
    return { missing: false, stale: true, stale_files: [] };
  }

  // Share one raw walk between tsconfig-fingerprint + graph-file enumeration.
  const raw = enumerateAllFiles(identity.repoPath);

  if (
    meta.tsconfig_fingerprint !==
    computeTsconfigFingerprint(identity.repoPath, raw.files, cfg.graph.tsconfig.enabled)
  ) {
    return { missing: false, stale: true, stale_files: [] };
  }

  const enumerated = enumerateGraphFilesFromRaw(identity.repoPath, cfg, raw);
  if (!enumerated.ok) {
    // Enumerate failed (git-unavailable shouldn't happen since
    // enumerateGraphFiles falls back to walk; repo-too-large would fail the
    // downstream build anyway). Surface as stale so buildGraph gets a chance
    // to produce a proper FailOpen — fail-open path on the handler side.
    return { missing: false, stale: true, stale_files: [] };
  }

  const current = new Set(enumerated.files);
  const previous = new Set(Object.keys(meta.file_hashes));
  const drift = new Set<string>();

  for (const file of current) {
    if (!previous.has(file)) drift.add(file);
  }
  for (const file of previous) {
    if (!current.has(file)) drift.add(file);
  }

  for (const file of current) {
    if (!previous.has(file)) continue;
    const absPath = join(identity.repoPath, ...file.split("/"));
    if (!existsSync(absPath)) {
      drift.add(file);
      continue;
    }
    let st: { ino: number; mtimeMs: number; size: number };
    try {
      const s = statSync(absPath);
      st = { ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      drift.add(file);
      continue;
    }
    if (!fileLooksUnchanged(meta, file, st)) drift.add(file);
  }

  const stale_files = [...drift].sort();
  return { missing: false, stale: stale_files.length > 0, stale_files };
};
