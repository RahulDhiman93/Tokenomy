import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../core/types.js";
import { loadConfig } from "../core/config.js";
import { writeAsyncBuildFailure } from "../graph/build-log.js";
import { join } from "node:path";
import {
  graphDir,
  graphDirtySentinelPath,
  graphRebuildStatsPath,
  type RepoIdentityLike,
} from "../core/paths.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { buildGraph } from "../graph/build.js";
import { safeParse } from "../util/json.js";
import { atomicWrite } from "../util/atomic.js";
import { appendGitignoreLine } from "../util/gitignore.js";
import {
  recordRebuildDelta,
  recordWorkerActiveDelta,
  recordWorkerInactiveDelta,
  readFoldedStats,
} from "../graph/freshness-stats.js";

// 0.1.9+: in-process rebuild worker. Watches `<graphDir>` for changes
// to the `.dirty` sentinel and triggers a debounced `buildGraph`. The
// goal is to take rebuild responsibility off the read path so MCP
// queries become observers of lag, not drivers of work.
//
// Why fs.watch and not periodic polling: the worker only cares about
// one specific filename in one directory. fs.watch lets us sleep until
// the kernel pokes us, costing one inotify slot per active repo.
// Network mounts (FUSE, some SMB) may not emit reliably — caller can
// disable via `graph.rebuild_worker.enabled = false` and fall back to
// the legacy read-driven `startBackgroundRebuild`.
//
// Per-repo state. `repoPath` is the absolute path returned by
// `resolveRepoId` and is the unique key — more discriminating than
// `repoId` under symlinks/worktrees.

// 0.1.10+ P7: worker observation mode. "watch" is fs.watch-driven
// (cheap inotify slot), "poll" is setInterval+statSync fallback for
// hosts where fs.watch doesn't work (NFS/FUSE/SMB, EMFILE quota,
// EBADF). "off" is the terminal state — the worker has decided this
// repo isn't watchable and the legacy read-driven path takes over.
export type WatcherMode = "watch" | "poll" | "off";

interface WorkerEntry {
  // 0.1.10+ P7: watcher may be null when the entry is in poll mode.
  watcher: FSWatcher | null;
  // 0.1.10+ P7: polling-mode handle. Null in watch mode.
  pollTimer: NodeJS.Timeout | null;
  // 0.1.10+ P7: last observed sentinel mtimeMs for the poll loop's
  // edge-trigger. -1 = not yet observed; 0 = sentinel absent.
  pollLastMtimeMs: number;
  mode: WatcherMode;
  timer: NodeJS.Timeout | null;
  cwd: string;
  identity: RepoIdentityLike;
  cfg: Config;
  // codex round 4 P1: bound the retry-on-failure loop. A repo that
  // always times out / hits io-error would otherwise rebuild forever
  // every debounce period. We cap consecutive retries at this number
  // and write the failure to the async-failure sentinel so the next
  // read-side response can surface it (matches `startBackgroundRebuild`
  // semantics from 0.1.8).
  consecutive_failures: number;
  // codex round 10 P2: when `.dirty` is appended DURING a long
  // build, schedule()ing another build would compete for the build
  // lock and surface bogus `build-in-progress` async failures.
  // Instead, set this flag and let the in-flight build's `then`
  // path trigger ONE follow-up schedule after it settles.
  build_in_flight: boolean;
  rerun_pending: boolean;
}

// 0.1.10+ P7: poll fallback interval. 500ms default — frequent enough
// that an interactive user doesn't perceive lag, sparse enough that
// the unref'd timer doesn't dominate CPU on idle repos.
const POLL_INTERVAL_MS = 500;

// Hard cap on consecutive retried failures before the worker gives
// up on this repo and waits for an external signal (fresh `.dirty`
// write — i.e. a real edit) to retry. 3 covers the case of a
// transient lock contention but stops thrashing on persistent
// failures.
const MAX_CONSECUTIVE_FAILURES = 3;

const workers = new Map<string, WorkerEntry>();
let shuttingDown = false;
// codex round 2 P2: track whether the MCP server lifecycle ran. Only
// `startGraphServer` sets this true; tests / direct callers leave it
// false and skip auto-registration via `dispatchGraphTool` so we don't
// leak fs.watch handles in environments without `stopAllWorkers`.
let serverModeActive = false;

export const markServerModeActive = (active: boolean): void => {
  serverModeActive = active;
};
export const isServerModeActive = (): boolean => serverModeActive;

export interface RebuildStats {
  count: number;
  last_ms: number;
  total_ms: number;
  last_ts: string;
  worker_active: boolean;
  // codex round 1 P3: scoped-stale counters live in the SAME file
  // (`<graphDir>/.rebuild-stats.json`). `recordRebuild` must preserve
  // them or every successful rebuild zeroes the report-time counters.
  stale_in_scope_hits?: number;
  stale_in_scope_misses?: number;
}

const readStats = (path: string): RebuildStats => {
  const blank: RebuildStats = {
    count: 0,
    last_ms: 0,
    total_ms: 0,
    last_ts: "",
    worker_active: true,
  };
  if (!existsSync(path)) return blank;
  const parsed = safeParse<Partial<RebuildStats>>(readFileSync(path, "utf8"));
  if (!parsed) return blank;
  // codex round 3 P1: normalize. recordScopedStaleSample creates the
  // file with ONLY scoped fields, so direct passthrough leaves
  // numeric fields undefined. Downstream consumers (readRebuildStats,
  // markStatsInactive, recordRebuild) all assume finite defaults.
  return {
    count: typeof parsed.count === "number" ? parsed.count : 0,
    last_ms: typeof parsed.last_ms === "number" ? parsed.last_ms : 0,
    total_ms: typeof parsed.total_ms === "number" ? parsed.total_ms : 0,
    last_ts: typeof parsed.last_ts === "string" ? parsed.last_ts : "",
    worker_active: parsed.worker_active === true,
    stale_in_scope_hits:
      typeof parsed.stale_in_scope_hits === "number" ? parsed.stale_in_scope_hits : 0,
    stale_in_scope_misses:
      typeof parsed.stale_in_scope_misses === "number" ? parsed.stale_in_scope_misses : 0,
  };
};

// 0.1.10+ P10e: delegate to the NDJSON-append delta logger so this
// write doesn't race recordScopedStaleSample. Local helper kept for
// clarity at call site.
const recordRebuild = (
  identity: RepoIdentityLike,
  cfg: Config,
  duration_ms: number,
): void => {
  try {
    recordRebuildDelta(identity, cfg, duration_ms);
  } catch {
    // best-effort
  }
};

// Public accessor for `tokenomy report` / `analyze`. 0.1.10+ folds
// the NDJSON delta log on top of the snapshot so concurrent writes
// from the worker + handlers + markStatsInactive all surface.
export const readRebuildStats = (
  identity: RepoIdentityLike,
  cfg: Config,
): RebuildStats => {
  const folded = readFoldedStats(identity, cfg);
  return {
    count: folded.count,
    last_ms: folded.last_ms,
    total_ms: folded.total_ms,
    last_ts: folded.last_ts,
    worker_active: folded.worker_active,
    stale_in_scope_hits: folded.stale_in_scope_hits,
    stale_in_scope_misses: folded.stale_in_scope_misses,
  };
};

// Whether the rebuild worker is currently watching a repo. Used by
// `ensureFreshGraph` to decide between "skip the rebuild kick, worker
// will pick it up" and the legacy `startBackgroundRebuild` path.
export const isWorkerActive = (repoPath: string): boolean => workers.has(repoPath);

const triggerBuild = (entry: WorkerEntry): void => {
  if (shuttingDown) return;
  const start = performance.now();
  // codex round 7 P2: re-load config so a mid-session edit to
  // `.tokenomy.json` (e.g. raising `graph.max_files` after a
  // repo-too-large failure, or adding an exclude pattern) is honored
  // on the very next rebuild. Pre-fix the worker would use the cfg
  // it captured at registration until the server restarted.
  let cfg: Config;
  try {
    cfg = loadConfig(entry.identity.repoPath);
  } catch {
    cfg = entry.cfg;
  }
  // codex round 9 P2: honor runtime opt-outs. If the reloaded
  // config disables the worker (or graph, or async rebuild — both
  // of which the worker depends on), tear down this watcher
  // instead of doing the background rebuild the user just
  // disabled. The next `.dirty` write after a re-enable would need
  // a server restart OR another `dispatchGraphTool` call to
  // re-register; that's acceptable for opt-out scenarios.
  if (
    !cfg.graph.enabled ||
    cfg.graph.rebuild_worker?.enabled === false ||
    cfg.graph.async_rebuild === false
  ) {
    try {
      markStatsInactive(entry.identity, cfg);
    } catch {
      // best-effort
    }
    unregisterRepo(entry.identity.repoPath);
    return;
  }
  // codex round 13 P2: storage location moved (e.g. `graph.location`
  // flipped to "home"). Tear down the watcher rooted at the old
  // graphDir; the next dispatch lazily re-registers at the new path.
  if (graphDir(entry.identity, cfg.graph) !== graphDir(entry.identity, entry.cfg.graph)) {
    unregisterRepo(entry.identity.repoPath);
    return;
  }
  // Update the entry's cached cfg so the lookback callsites
  // (schedule's debounce read, postBuildSuccess's storage location)
  // see the fresh value too.
  entry.cfg = cfg;
  // codex round 10 P2: mark in-flight so concurrent .dirty appends
  // queue "rerun once" via the `rerun_pending` flag instead of
  // racing the build lock.
  entry.build_in_flight = true;
  entry.rerun_pending = false;
  buildGraph({ cwd: entry.cwd, config: cfg, force: false })
    .then((res) => {
      if (res.ok) {
        entry.consecutive_failures = 0;
        // codex round 8 P2 / round 16 P2: don't reactivate stats
        // after shutdown OR after this entry was unregistered
        // mid-build (fs.watch error, storage-location flip,
        // runtime opt-out). Either condition means the worker is
        // no longer "live"; writing `worker_active: true` would
        // lie about server state to the next `tokenomy report`.
        if (shuttingDown) return;
        if (!workers.has(entry.identity.repoPath)) return;
        recordRebuild(entry.identity, entry.cfg, Math.round(performance.now() - start));
        // codex round 4 P2: postBuildSuccess deliberately leaves
        // `.dirty` in place when it detects a mid-build edit (the
        // inode/mtime/size guard). fs.watch may have coalesced the
        // mid-build append into a single event we already consumed,
        // so the worker can otherwise go idle while `.dirty` still
        // exists. Re-arm a follow-up build if so.
        if (existsSync(graphDirtySentinelPath(entry.identity, entry.cfg.graph))) {
          schedule(entry);
        }
        return;
      }
      // codex round 1 P2 / round 4 P1: handle non-ok results. Only
      // retry transient lock contention (`build-in-progress`) — that
      // path is short and self-clearing. Persistent failures
      // (`timeout`, `io-error`, etc.) get written to the async-
      // failure sentinel for read-side annotation and DO NOT
      // reschedule, so the worker doesn't burn CPU on a doomed
      // repo. The next fresh `.dirty` write (a real new edit) will
      // re-arm the watcher path; a manual `tokenomy graph build`
      // still works if the user wants to retry explicitly.
      if (res.reason === "build-in-progress") {
        entry.consecutive_failures += 1;
        if (
          !shuttingDown &&
          entry.consecutive_failures < MAX_CONSECUTIVE_FAILURES
        ) {
          schedule(entry);
        } else {
          writeAsyncBuildFailure(
            entry.identity,
            {
              ts: new Date().toISOString(),
              reason: res.reason,
              hint:
                "rebuild worker exhausted retries on build-in-progress; manual rebuild required",
            },
            entry.cfg.graph,
          );
          entry.consecutive_failures = 0;
        }
        return;
      }
      // Non-retryable failure. Record + stop.
      writeAsyncBuildFailure(
        entry.identity,
        {
          ts: new Date().toISOString(),
          reason: res.reason,
          ...(res.hint ? { hint: res.hint } : {}),
        },
        entry.cfg.graph,
      );
      entry.consecutive_failures = 0;
    })
    .catch((e) => {
      // buildGraph is non-throwing in practice; defensive only.
      // Record the failure so it surfaces on the next cacheable read.
      writeAsyncBuildFailure(
        entry.identity,
        {
          ts: new Date().toISOString(),
          reason: "io-error",
          hint: (e as Error).message,
        },
        entry.cfg.graph,
      );
      entry.consecutive_failures = 0;
    })
    .finally(() => {
      // codex round 10 P2: clear in-flight flag and run ONE
      // follow-up if a .dirty change landed during this build.
      entry.build_in_flight = false;
      if (entry.rerun_pending && !shuttingDown) {
        entry.rerun_pending = false;
        schedule(entry);
      }
    });
};

// 0.1.10+ P7: switch this entry from watch to poll mode. Closes the
// fs.watch handle (if any), starts a setInterval that statSyncs the
// sentinel and schedules a rebuild on mtime change. .unref() so the
// timer doesn't keep the process alive.
const switchToPollMode = (entry: WorkerEntry): void => {
  if (entry.mode === "poll" && entry.pollTimer !== null) return;
  if (entry.watcher) {
    try {
      entry.watcher.close();
    } catch {
      // best-effort
    }
    entry.watcher = null;
  }
  entry.mode = "poll";
  entry.pollLastMtimeMs = -1;
  const tick = (): void => {
    if (shuttingDown) return;
    const sentinel = graphDirtySentinelPath(entry.identity, entry.cfg.graph);
    let mtime = 0;
    try {
      if (existsSync(sentinel)) {
        mtime = statSync(sentinel).mtimeMs;
      }
    } catch {
      mtime = 0;
    }
    if (mtime === 0) {
      // 0.1.10+ codex round 5 P2: sentinel disappeared (rebuild
      // cleared it). Reset the watermark so a future edit that
      // happens to recreate .dirty with the same mtime (coarse-mtime
      // filesystems) still schedules. Pre-fix the watermark kept the
      // old non-zero value and read-side staleness silently waited
      // for the 60s lag fallback.
      entry.pollLastMtimeMs = 0;
    } else if (mtime !== entry.pollLastMtimeMs) {
      entry.pollLastMtimeMs = mtime;
      schedule(entry);
    }
  };
  entry.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  entry.pollTimer.unref();
};

const schedule = (entry: WorkerEntry): void => {
  // codex round 10 P2: if a build is already running, don't queue
  // another timer that will race the lock. Mark "rerun after this
  // one settles" — the .then path handles re-scheduling once.
  if (entry.build_in_flight) {
    entry.rerun_pending = true;
    return;
  }
  const debounce = entry.cfg.graph.rebuild_worker?.debounce_ms ?? 150;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    triggerBuild(entry);
  }, debounce);
};

// Idempotent registration. Cheap when the repo is already watched —
// the caller (MCP dispatch) can pass effectiveCwd on every tool call.
export const registerRepo = (cwd: string, cfg: Config): void => {
  // codex round 15 P2: when the runtime config now disables the
  // worker (any of graph.enabled / rebuild_worker.enabled /
  // async_rebuild flipped to false mid-session), tear down any
  // existing entry for this repo BEFORE bailing. The early-return
  // pre-fix left the stale watcher in the Map, and
  // `ensureFreshGraph`'s `isWorkerActive` shortcut kept suppressing
  // the legacy read-driven rebuild — defeating the opt-out users
  // typically rely on for hostile filesystems.
  const optedOut =
    !cfg.graph.enabled ||
    cfg.graph.rebuild_worker?.enabled === false ||
    cfg.graph.async_rebuild === false;
  if (optedOut) {
    let probeIdentity: RepoIdentityLike;
    try {
      probeIdentity = resolveRepoId(cwd);
    } catch {
      return;
    }
    if (workers.has(probeIdentity.repoPath)) {
      try {
        markStatsInactive(probeIdentity, cfg);
      } catch {
        // best-effort
      }
      unregisterRepo(probeIdentity.repoPath);
    }
    return;
  }
  if (shuttingDown) return;
  let identity: RepoIdentityLike;
  try {
    identity = resolveRepoId(cwd);
  } catch {
    return;
  }
  // codex round 13 P2: detect storage-location change. If the
  // existing worker is watching a different graphDir than what the
  // current cfg resolves to (e.g. `graph.location` flipped from
  // "in-repo" to "home" mid-session), tear down the stale watcher
  // so we can register a fresh one against the new path.
  const existing = workers.get(identity.repoPath);
  const desiredDir = graphDir(identity, cfg.graph);
  if (existing) {
    const existingDir = graphDir(existing.identity, existing.cfg.graph);
    if (existingDir === desiredDir) return;
    unregisterRepo(identity.repoPath);
  }

  const dir = desiredDir;
  // codex round 2 P3: do NOT eagerly create `<repo>/.tokenomy-graph/`
  // when no graph snapshot exists yet — that would leave
  // `?? .tokenomy-graph/` in `git status` for users on `init --no-build`
  // or after a purge. If the dir is missing, the first `buildGraph`
  // run will create it (and apply the .gitignore patch). The watcher
  // just declines to register until then.
  if (!existsSync(dir)) {
    return;
  }
  // 0.1.9+: belt-and-suspenders. Even when the dir exists we make
  // sure `.tokenomy-graph/` is in `.gitignore` — covers the case
  // where someone built the graph before the auto-gitignore patch
  // was added (or under `auto_gitignore: false`).
  if (
    (cfg.graph.location ?? "in-repo") === "in-repo" &&
    cfg.graph.auto_gitignore !== false
  ) {
    try {
      appendGitignoreLine(join(identity.repoPath, ".gitignore"), ".tokenomy-graph/");
    } catch {
      // best-effort
    }
  }
  // codex round 11 P3: clear any leftover worker_active=true from a
  // prior session before attempting fs.watch. If watch throws and we
  // return early, the next `tokenomy report` will accurately show the
  // worker as inactive instead of inheriting stale state.
  try {
    markStatsInactive(identity, cfg);
  } catch {
    // best-effort
  }

  let watcher: FSWatcher | null = null;
  let initialMode: WatcherMode = "watch";
  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      // codex round 6 P2: filename CAN be null on some platforms
      // (older macOS, certain network mounts). Pre-fix we'd drop
      // those events entirely — now that ensureFreshGraph delegates
      // sentinel-driven staleness to the worker instead of firing
      // its own background rebuild, those repos would stay stale.
      // When filename is null, fall back to a direct existsSync on
      // the sentinel and schedule if it's there.
      if (filename) {
        const name = typeof filename === "string" ? filename : String(filename);
        if (name !== ".dirty") return;
      }
      // codex round 3 P2: fs.watch fires a `rename` event when
      // `postBuildSuccess` deletes `.dirty`. Without this gate we'd
      // schedule a redundant no-op rebuild after every successful
      // build — costly on large graphs. Only schedule when the
      // sentinel actually exists at event time.
      if (!existsSync(graphDirtySentinelPath(identity, cfg.graph))) return;
      const entry = workers.get(identity.repoPath);
      if (entry) schedule(entry);
    });
  } catch (err) {
    // 0.1.10+ P7: classify fs.watch failure and fall back to polling
    // on hosts where the kernel can't help us (EMFILE inotify quota,
    // EBADF transient, ENOSPC out-of-watches, ENOTSUP on certain
    // network mounts). Pre-0.1.10 we'd unregister and let the legacy
    // read-driven path take over; polling keeps the worker writing
    // freshness samples and serving the lag-aware fast-path.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EMFILE" || code === "ENOSPC") {
      // Surface inotify-quota hits to the async-failure sentinel so
      // doctor / report can show the actionable hint.
      try {
        writeAsyncBuildFailure(
          identity,
          {
            ts: new Date().toISOString(),
            reason: "inotify-quota",
            hint: "raise fs.inotify.max_user_watches and restart the server",
          },
          cfg.graph,
        );
      } catch {
        // best-effort
      }
    }
    initialMode = "poll";
    watcher = null;
  }

  if (watcher !== null) {
    watcher.on("error", () => {
      // Best-effort: drop into polling rather than unregistering. A
      // single fs.watch error in a long session usually means the
      // kernel handle got invalidated (rename, remount); polling
      // keeps the freshness signal alive until the worker can
      // re-bind on the next registerRepo.
      try {
        markStatsInactive(identity, cfg);
      } catch {
        // best-effort
      }
      const entry = workers.get(identity.repoPath);
      if (entry) switchToPollMode(entry);
    });
  }

  const entry: WorkerEntry = {
    watcher,
    pollTimer: null,
    pollLastMtimeMs: -1,
    mode: initialMode,
    timer: null,
    cwd,
    identity,
    cfg,
    consecutive_failures: 0,
    build_in_flight: false,
    rerun_pending: false,
  };
  workers.set(identity.repoPath, entry);
  if (initialMode === "poll") switchToPollMode(entry);

  // codex round 4 P3: mark worker_active=true in the stats file at
  // registration so `tokenomy report` / `analyze` show the worker as
  // alive immediately, even before the first rebuild runs. Reading
  // ONLY the stats file (collectGraphFreshness) would otherwise show
  // worker_active=false until the first rebuild lands — confusing on
  // already-built repos where no rebuild may ever fire in a session.
  try {
    const statsPath = graphRebuildStatsPath(identity, cfg.graph);
    const prev = readStats(statsPath);
    const next: RebuildStats = {
      count: prev.count,
      last_ms: prev.last_ms,
      total_ms: prev.total_ms,
      last_ts: prev.last_ts,
      worker_active: true,
      stale_in_scope_hits: prev.stale_in_scope_hits ?? 0,
      stale_in_scope_misses: prev.stale_in_scope_misses ?? 0,
    };
    atomicWrite(statsPath, JSON.stringify(next));
    // codex round 2 P2: also append a worker_active:true delta to
    // the NDJSON log. The folded reader replays the log AFTER the
    // snapshot, so a previous-session shutdown's worker_active:false
    // delta would otherwise stick across restarts until the next
    // rebuild fired its own worker_active:true delta.
    recordWorkerActiveDelta(identity, cfg);
  } catch {
    // best-effort
  }

  // codex round 1 P2: if `.dirty` already exists at register time
  // (PostToolUse fired before the server connected, or the previous
  // session left it behind), schedule an immediate rebuild. fs.watch
  // only reports FUTURE changes, so without this kick the sentinel
  // would sit forever and every read would observe stale data.
  try {
    if (existsSync(graphDirtySentinelPath(identity, cfg.graph))) {
      schedule(entry);
    }
  } catch {
    // best-effort
  }
};

export const unregisterRepo = (repoPath: string): void => {
  const entry = workers.get(repoPath);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.pollTimer) clearInterval(entry.pollTimer);
  if (entry.watcher) {
    try {
      entry.watcher.close();
    } catch {
      // best-effort
    }
  }
  workers.delete(repoPath);
};

// Called by `startGraphServer`'s onclose handler. Tears down every
// watcher and clears outstanding timers so the process can exit.
// codex round 2 P3: flip each repo's stats file to `worker_active:
// false` BEFORE removing it from the workers map. Pre-fix, after a
// server exit the stats file kept `worker_active: true`, so
// `tokenomy report` lied about the worker being alive in subsequent
// CLI invocations.
export const stopAllWorkers = (): void => {
  shuttingDown = true;
  for (const key of [...workers.keys()]) {
    const entry = workers.get(key);
    if (entry) markStatsInactive(entry.identity, entry.cfg);
    unregisterRepo(key);
  }
  serverModeActive = false;
};

// Test affordance — restart from a clean slate between tests.
export const _resetWorkersForTests = (): void => {
  for (const key of [...workers.keys()]) unregisterRepo(key);
  shuttingDown = false;
  serverModeActive = false;
};

// Mark stats file as having an inactive worker. Called at process
// exit; lets `tokenomy report` show worker_active:false on a stale
// stats file from a prior session.
export const markStatsInactive = (
  identity: RepoIdentityLike,
  cfg: Config,
): void => {
  try {
    recordWorkerInactiveDelta(identity, cfg);
  } catch {
    // best-effort
  }
};
