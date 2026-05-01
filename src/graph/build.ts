import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../core/types.js";
import { graphBuildLogPath, graphDirtySentinelPath, graphLockPath } from "../core/paths.js";
import { TOKENOMY_VERSION } from "../core/version.js";
import { enumerateAllFiles, enumerateGraphFiles } from "./enumerate.js";
import { fingerprintExcludes } from "./exclude-fingerprint.js";
import { computeTsconfigFingerprint } from "./tsconfig-fingerprint.js";
import { createTsconfigResolver } from "./tsconfig-resolver.js";
import type { TsconfigResolver } from "./tsconfig-resolver.js";
import { sha256FileSync } from "./hash.js";
import { resolveRepoId } from "./repo-id.js";
import {
  GRAPH_SCHEMA_VERSION,
  normalizeGraph,
  type Edge,
  type Graph,
  type GraphMeta,
  type Node,
} from "./schema.js";
import { getGraphStaleStatus } from "./stale.js";
import { JsonGraphStore, serializeGraphSnapshot } from "./store.js";
import { readLastGraphBuildFailure } from "./build-log.js";
import type { BuildGraphResult, FailOpen } from "./types.js";
import { loadTypescript } from "../parsers/ts/loader.js";
import { extractTsFileGraph } from "../parsers/ts/extract.js";
import { appendGraphBuildLog } from "../core/log.js";

export interface BuildGraphOptions {
  cwd: string;
  force?: boolean;
  config: Config;
}

const fail = (reason: string, hint?: string): FailOpen => ({ ok: false, reason, hint });

const logGraphBuild = (
  repoId: string,
  repoPath: string,
  result: BuildGraphResult,
): void => {
  appendGraphBuildLog(graphBuildLogPath(repoId), {
    ts: new Date().toISOString(),
    repo_id: repoId,
    repo_path: repoPath,
    built: result.ok ? result.data.built : false,
    node_count: result.ok ? result.data.node_count : 0,
    edge_count: result.ok ? result.data.edge_count : 0,
    parse_error_count: result.ok ? result.data.parse_error_count : 0,
    duration_ms: result.ok ? result.data.duration_ms : 0,
    ...(result.ok ? { skipped_files: result.data.skipped_files } : { reason: result.reason, hint: result.hint }),
  });
};

// If more than this fraction of files are stale, the delta merge overhead
// outweighs the savings; fall back to full rebuild.
const DELTA_MAX_RATIO = 0.4;

// Build id→owner-file map from a list of nodes. Real graph IDs use prefixes
// `file:`, `ext:`, `sym:`, `imp:`, `exp:`, `test:`. Every non-`ext:` node
// carries a `file` field; `ext:<specifier>` nodes have no owning file (they
// represent repo-wide external module references and must not be dropped on
// per-file deltas).
const buildOwnerMap = (nodes: Node[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const n of nodes) {
    if (typeof n.file === "string" && n.file.length > 0) map.set(n.id, n.file);
  }
  return map;
};

// Stale expansion: stale files + any file whose prior edges point INTO a
// stale file (direct importer). Catches renamed/deleted exports whose
// importers would otherwise keep dangling edges.
const expandStaleWithImporters = (
  edges: Edge[],
  staleSet: Set<string>,
  owners: Map<string, string>,
): Set<string> => {
  const expanded = new Set(staleSet);
  for (const e of edges) {
    const toFile = owners.get(e.to);
    const fromFile = owners.get(e.from);
    if (!toFile || !fromFile) continue;
    if (staleSet.has(toFile) && !staleSet.has(fromFile)) expanded.add(fromFile);
  }
  return expanded;
};

const deltaBuildFromSnapshot = async (
  repoId: string,
  repoPath: string,
  prevMeta: GraphMeta,
  prevGraph: Graph,
  allFiles: string[],
  skipped_files: string[],
  staleFiles: string[],
  cfg: Config,
): Promise<BuildGraphResult> => {
  try {
    const deadline = Date.now() + cfg.graph.build_timeout_ms;
    const tsLoaded = await loadTypescript(repoPath);
    if (!tsLoaded.ok) return tsLoaded;

    const staleSet = new Set(staleFiles);
    const owners = buildOwnerMap(prevGraph.nodes);
    const expanded = expandStaleWithImporters(prevGraph.edges, staleSet, owners);
    const allFileSet = new Set(allFiles);
    // Drop any expanded entry that was fully removed from disk — nothing to re-parse.
    for (const f of [...expanded]) if (!allFileSet.has(f)) expanded.delete(f);

    // Kept nodes: external nodes (no `file`) always kept. Every other node
    // has `n.file` set by its creator — keep if its owner isn't in the
    // expanded set and still exists on disk.
    const keptNodes: Node[] = [];
    const keptNodeIds = new Set<string>();
    for (const n of prevGraph.nodes) {
      const owner = typeof n.file === "string" && n.file.length > 0 ? n.file : null;
      if (owner === null) {
        keptNodes.push(n);
        keptNodeIds.add(n.id);
        continue;
      }
      if (!expanded.has(owner) && allFileSet.has(owner)) {
        keptNodes.push(n);
        keptNodeIds.add(n.id);
      }
    }
    // Kept edges: both endpoints must resolve to either a kept node OR a
    // stable external-module node (no file owner). Everything else drops so
    // we never leave dangling edges pointing into re-parsed files.
    const keptEdges: Edge[] = [];
    for (const e of prevGraph.edges) {
      const fromOk =
        keptNodeIds.has(e.from) || (owners.get(e.from) === undefined && e.from.startsWith("ext:"));
      const toOk =
        keptNodeIds.has(e.to) || (owners.get(e.to) === undefined && e.to.startsWith("ext:"));
      if (fromOk && toOk) keptEdges.push(e);
    }
    const keptParseErrors = prevGraph.parse_errors.filter(
      (pe) => !expanded.has(pe.file) && allFileSet.has(pe.file),
    );

    let tsconfigResolver: TsconfigResolver | undefined;
    const raw = enumerateAllFiles(repoPath);
    if (cfg.graph.tsconfig.enabled) {
      tsconfigResolver = createTsconfigResolver(repoPath, allFileSet, tsLoaded.ts, raw.files);
    }

    // Re-parse only expanded files. Newly-added files are included because
    // getGraphStaleStatus puts them in stale_files.
    const file_hashes: Record<string, string> = { ...prevMeta.file_hashes };
    const file_mtimes: Record<string, number> = { ...prevMeta.file_mtimes };
    // Drop hashes for removed files so the new meta is accurate.
    for (const f of Object.keys(file_hashes)) if (!allFileSet.has(f)) delete file_hashes[f];
    for (const f of Object.keys(file_mtimes)) if (!allFileSet.has(f)) delete file_mtimes[f];

    const addedNodes: Node[] = [];
    const addedEdges: Edge[] = [];
    const addedErrors: Graph["parse_errors"] = [];
    for (const file of expanded) {
      if (Date.now() > deadline) return fail("timeout");
      const absPath = join(repoPath, ...file.split("/"));
      const st = statSync(absPath);
      file_hashes[file] = sha256FileSync(absPath);
      file_mtimes[file] = st.mtimeMs;
      const source = readFileSync(absPath, "utf8");
      const extracted = extractTsFileGraph(file, source, allFileSet, tsLoaded.ts, tsconfigResolver);
      if (extracted.edges.length > cfg.graph.max_edges_per_file) {
        return fail(
          "graph-too-large",
          `Edge cap exceeded in ${file} — add it to graph.exclude or pass --exclude '${suggestExcludeGlob(file)}'`,
        );
      }
      addedNodes.push(...extracted.nodes);
      addedEdges.push(...extracted.edges);
      addedErrors.push(...extracted.parse_errors);
    }

    const graph = normalizeGraph({
      schema_version: GRAPH_SCHEMA_VERSION,
      repo_id: repoId,
      nodes: [...keptNodes, ...addedNodes],
      edges: [...keptEdges, ...addedEdges],
      parse_errors: [...keptParseErrors, ...addedErrors],
    });
    const serialized = serializeGraphSnapshot(graph);
    const snapshotBytes = Buffer.byteLength(serialized, "utf8");
    if (snapshotBytes > cfg.graph.max_snapshot_bytes) {
      return fail(
        "graph-too-large",
        `Snapshot was ${snapshotBytes} bytes, exceeding graph.max_snapshot_bytes=${cfg.graph.max_snapshot_bytes}. Raise graph.max_snapshot_bytes or exclude generated/large files.`,
      );
    }

    const tsconfigFingerprint = computeTsconfigFingerprint(
      repoPath,
      raw.files,
      cfg.graph.tsconfig.enabled,
    );
    const meta: GraphMeta = {
      schema_version: GRAPH_SCHEMA_VERSION,
      repo_id: repoId,
      repo_path: repoPath,
      built_at: new Date().toISOString(),
      tokenomy_version: TOKENOMY_VERSION,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      file_hashes,
      file_mtimes,
      soft_cap: cfg.graph.max_files,
      hard_cap: cfg.graph.hard_max_files,
      parse_error_count: graph.parse_errors.length,
      skipped_files,
      exclude_fingerprint: fingerprintExcludes(cfg.graph.exclude),
      tsconfig_fingerprint: tsconfigFingerprint,
    };
    new JsonGraphStore().save(repoId, graph, meta);
    return {
      ok: true,
      stale: false,
      stale_files: [],
      data: {
        repo_id: repoId,
        built: true,
        node_count: graph.nodes.length,
        edge_count: graph.edges.length,
        parse_error_count: graph.parse_errors.length,
        duration_ms: 0,
        skipped_files,
      },
    };
  } catch (error) {
    return fail("io-error", (error as Error).message);
  }
};

const suggestExcludeGlob = (file: string): string => {
  const slash = file.indexOf("/");
  if (slash === -1) return file;
  return `${file.slice(0, slash)}/**`;
};

// 0.1.7+: stale-lock reclaim. Pre-0.1.7 a SIGKILL during build (OOM,
// watchdog, user kill -9) leaked the `.lock` sentinel forever, so every
// future build returned `build-in-progress` until the user manually rm'd
// it. Now we stamp PID + ISO timestamp into the lock, and on conflict
// we reclaim if the holder PID is dead OR the lock is older than 10
// minutes (any healthy build finishes in well under that).
const BUILD_LOCK_STALE_MS = 10 * 60 * 1000;

const isPidAlive = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists but we can't signal it — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const isStaleLock = (path: string): boolean => {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
    const pid = typeof parsed.pid === "number" ? parsed.pid : NaN;
    const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
    if (Number.isFinite(ts) && Date.now() - ts > BUILD_LOCK_STALE_MS) return true;
    if (Number.isFinite(pid) && !isPidAlive(pid)) return true;
    return false;
  } catch {
    // Lock file is missing or unparseable — treat as stale so we can
    // reclaim. Pre-0.1.7 locks were empty files; this path catches them.
    try {
      const st = statSync(path);
      if (Date.now() - st.mtimeMs > BUILD_LOCK_STALE_MS) return true;
    } catch {
      return true;
    }
    return false;
  }
};

const acquireBuildLock = (repoId: string): (() => void) | FailOpen => {
  const path = graphLockPath(repoId);
  mkdirSync(dirname(path), { recursive: true });
  const stamp = (fd: number): void => {
    writeSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
  };
  try {
    const fd = openSync(path, "wx");
    stamp(fd);
    return () => {
      closeSync(fd);
      rmSync(path, { force: true });
    };
  } catch {
    if (isStaleLock(path)) {
      try {
        rmSync(path, { force: true });
        const fd = openSync(path, "wx");
        stamp(fd);
        return () => {
          closeSync(fd);
          rmSync(path, { force: true });
        };
      } catch {
        return fail("build-in-progress");
      }
    }
    return fail("build-in-progress");
  }
};

const buildGraphFromFiles = async (
  repoId: string,
  repoPath: string,
  files: string[],
  skipped_files: string[],
  cfg: Config,
): Promise<BuildGraphResult> => {
  const tsLoaded = await loadTypescript(repoPath);
  if (!tsLoaded.ok) return tsLoaded;

  const deadline = Date.now() + cfg.graph.build_timeout_ms;
  const fileSet = new Set(files);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const parse_errors: Graph["parse_errors"] = [];
  const file_hashes: Record<string, string> = {};
  const file_mtimes: Record<string, number> = {};

  // Build the tsconfig-paths resolver once per build, share across every
  // file's extraction. Skipped when disabled or when TypeScript isn't
  // present — pre-alpha.17 behavior falls out naturally.
  let tsconfigResolver: TsconfigResolver | undefined;
  // Always compute + persist the tsconfig fingerprint — even when the
  // resolver is disabled — so toggling `graph.tsconfig.enabled` from true
  // ↔ false invalidates any previously-cached graph. The "disabled" state
  // uses a distinct sentinel hash so the stale check never confuses the two.
  const raw = enumerateAllFiles(repoPath);
  if (cfg.graph.tsconfig.enabled) {
    tsconfigResolver = createTsconfigResolver(repoPath, fileSet, tsLoaded.ts, raw.files);
  }
  const tsconfigFingerprint = computeTsconfigFingerprint(
    repoPath,
    raw.files,
    cfg.graph.tsconfig.enabled,
  );

  for (const file of files) {
    if (Date.now() > deadline) return fail("timeout");
    const absPath = join(repoPath, ...file.split("/"));
    const st = statSync(absPath);
    file_hashes[file] = sha256FileSync(absPath);
    file_mtimes[file] = st.mtimeMs;
    const source = readFileSync(absPath, "utf8");
    const extracted = extractTsFileGraph(file, source, fileSet, tsLoaded.ts, tsconfigResolver);
    if (extracted.edges.length > cfg.graph.max_edges_per_file) {
      return fail(
        "graph-too-large",
        `Edge cap exceeded in ${file} — add it to graph.exclude or pass --exclude '${suggestExcludeGlob(file)}'`,
      );
    }
    nodes.push(...extracted.nodes);
    edges.push(...extracted.edges);
    parse_errors.push(...extracted.parse_errors);
  }

  const graph = normalizeGraph({
    schema_version: GRAPH_SCHEMA_VERSION,
    repo_id: repoId,
    nodes,
    edges,
    parse_errors,
  });
  const serialized = serializeGraphSnapshot(graph);
  const snapshotBytes = Buffer.byteLength(serialized, "utf8");
  if (snapshotBytes > cfg.graph.max_snapshot_bytes) {
    return fail(
      "graph-too-large",
      `Snapshot was ${snapshotBytes} bytes, exceeding graph.max_snapshot_bytes=${cfg.graph.max_snapshot_bytes}. Raise graph.max_snapshot_bytes or exclude generated/large files.`,
    );
  }

  const meta: GraphMeta = {
    schema_version: GRAPH_SCHEMA_VERSION,
    repo_id: repoId,
    repo_path: repoPath,
    built_at: new Date().toISOString(),
    tokenomy_version: TOKENOMY_VERSION,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    file_hashes,
    file_mtimes,
    soft_cap: cfg.graph.max_files,
    hard_cap: cfg.graph.hard_max_files,
    parse_error_count: graph.parse_errors.length,
    skipped_files,
    exclude_fingerprint: fingerprintExcludes(cfg.graph.exclude),
    tsconfig_fingerprint: tsconfigFingerprint,
  };
  new JsonGraphStore().save(repoId, graph, meta);

  return {
    ok: true,
    stale: false,
    stale_files: [],
    data: {
      repo_id: repoId,
      built: true,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      parse_error_count: graph.parse_errors.length,
      duration_ms: 0,
      skipped_files,
    },
  };
};

export const buildGraph = async (options: BuildGraphOptions): Promise<BuildGraphResult> => {
  const start = Date.now();
  const identity = resolveRepoId(options.cwd);
  const store = new JsonGraphStore();

  if (!options.config.graph.enabled) {
    const result = fail("graph-disabled");
    logGraphBuild(identity.repoId, identity.repoPath, result);
    return result;
  }

  const unlock = acquireBuildLock(identity.repoId);
  if (typeof unlock !== "function") {
    logGraphBuild(identity.repoId, identity.repoPath, unlock);
    return unlock;
  }

  try {
    if (!options.force) {
      const existingMeta = store.loadMeta(identity.repoId);
      const existingGraph = store.loadGraph(identity.repoId);
      if (existingMeta && existingGraph) {
        const stale = getGraphStaleStatus(identity.repoPath, existingMeta, options.config);
        if (!stale.ok) {
          logGraphBuild(identity.repoId, identity.repoPath, stale);
          return stale;
        }
        if (!stale.stale) {
          const result: BuildGraphResult = {
            ok: true,
            stale: false,
            stale_files: [],
            data: {
              repo_id: identity.repoId,
              built: false,
              node_count: existingMeta.node_count,
              edge_count: existingMeta.edge_count,
              parse_error_count: existingMeta.parse_error_count,
              duration_ms: Date.now() - start,
              skipped_files: existingMeta.skipped_files ?? [],
            },
          };
          logGraphBuild(identity.repoId, identity.repoPath, result);
          return result;
        }
        // Incremental (beta-3): re-parse only stale files + their direct
        // importers; splice into the prior graph. Skipped on
        //   - cfg.graph.incremental === false (default)
        //   - stale.stale_files.length === 0 (no granular file list, e.g.
        //     tsconfig or exclude fingerprint changed → full rebuild)
        //   - stale ratio > DELTA_MAX_RATIO → churn isn't worth the
        //     merge bookkeeping; bail to full rebuild.
        if (options.config.graph.incremental === true && stale.stale_files.length > 0) {
          const enumerated = enumerateGraphFiles(identity.repoPath, options.config);
          if (enumerated.ok && enumerated.files.length > 0) {
            const ratio = stale.stale_files.length / enumerated.files.length;
            if (ratio <= DELTA_MAX_RATIO) {
              const delta = await deltaBuildFromSnapshot(
                identity.repoId,
                identity.repoPath,
                existingMeta,
                existingGraph,
                enumerated.files,
                enumerated.skipped_files,
                stale.stale_files,
                options.config,
              );
              if (delta.ok) {
                delta.data.duration_ms = Date.now() - start;
                logGraphBuild(identity.repoId, identity.repoPath, delta);
                return delta;
              }
              // Fall through to full rebuild if delta couldn't complete.
            }
          }
        }
      }
    }

    const enumerated = enumerateGraphFiles(identity.repoPath, options.config);
    if (!enumerated.ok) {
      logGraphBuild(identity.repoId, identity.repoPath, enumerated);
      return enumerated;
    }
    if (enumerated.files.length === 0) {
      const result = fail("no-files");
      logGraphBuild(identity.repoId, identity.repoPath, result);
      return result;
    }

    const built = await buildGraphFromFiles(
      identity.repoId,
      identity.repoPath,
      enumerated.files,
      enumerated.skipped_files,
      options.config,
    );
    if (!built.ok) {
      logGraphBuild(identity.repoId, identity.repoPath, built);
      return built;
    }
    built.data.duration_ms = Date.now() - start;
    logGraphBuild(identity.repoId, identity.repoPath, built);
    // 0.1.3+: clear the dirty sentinel after a successful rebuild so the
    // next isGraphStaleCheap call falls back to its normal mtime walk
    // instead of short-circuiting to "stale". Best-effort; missing-file
    // is the desired post-state anyway.
    try {
      const dirty = graphDirtySentinelPath(identity.repoId);
      if (existsSync(dirty)) rmSync(dirty, { force: true });
    } catch {
      // ignore
    }
    return built;
  } catch (error) {
    const result = fail("io-error", (error as Error).message);
    logGraphBuild(identity.repoId, identity.repoPath, result);
    return result;
  } finally {
    unlock();
  }
};

export const readGraphStatus = (cwd: string, config: Config): import("./types.js").GraphStatusResult => {
  if (!config.graph.enabled) return fail("graph-disabled");
  const identity = resolveRepoId(cwd);
  const store = new JsonGraphStore();
  const meta = store.loadMeta(identity.repoId);
  const graph = store.loadGraph(identity.repoId);
  if (!meta || !graph) return readLastGraphBuildFailure(identity.repoId) ?? fail("graph-not-built");

  const stale = getGraphStaleStatus(identity.repoPath, meta, config);
  if (!stale.ok) return stale;

  return {
    ok: true,
    stale: stale.stale,
    stale_files: stale.stale_files,
    data: {
      repo_id: identity.repoId,
      repo_path: meta.repo_path,
      built_at: meta.built_at,
      file_count: Object.keys(meta.file_hashes).length,
      node_count: meta.node_count,
      edge_count: meta.edge_count,
      parse_error_count: meta.parse_error_count,
      skipped_files: meta.skipped_files ?? [],
    },
  };
};
