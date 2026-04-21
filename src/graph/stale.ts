import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/types.js";
import { graphSnapshotPath } from "../core/paths.js";
import type { GraphMeta } from "./schema.js";
import { enumerateGraphFiles } from "./enumerate.js";
import { fingerprintExcludes } from "./exclude-fingerprint.js";
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

export interface CheapStaleStatus {
  missing: boolean;
  stale: boolean;
  stale_files: string[];
}

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

  const enumerated = enumerateGraphFiles(repoPath, cfg);
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
    let currentMtime = 0;
    try {
      currentMtime = statSync(absPath).mtimeMs;
    } catch {
      stale.add(file);
      continue;
    }
    if (meta.file_mtimes[file] === currentMtime) continue;
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
  const meta = store.loadMeta(identity.repoId);
  if (!meta) return { missing: true, stale: true, stale_files: [] };
  // meta.json alone isn't enough — the read-side query also needs the graph
  // snapshot. If it's been deleted (or never written), treat as missing so
  // ensureFreshGraph triggers a rebuild instead of letting downstream queries
  // fail with graph-not-built. Codex round 1 review catch.
  if (!existsSync(graphSnapshotPath(identity.repoId))) {
    return { missing: true, stale: true, stale_files: [] };
  }

  if (meta.exclude_fingerprint !== fingerprintExcludes(cfg.graph.exclude)) {
    return { missing: false, stale: true, stale_files: [] };
  }

  const enumerated = enumerateGraphFiles(identity.repoPath, cfg);
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
    let currentMtime = 0;
    try {
      currentMtime = statSync(absPath).mtimeMs;
    } catch {
      drift.add(file);
      continue;
    }
    if (meta.file_mtimes[file] !== currentMtime) drift.add(file);
  }

  const stale_files = [...drift].sort();
  return { missing: false, stale: stale_files.length > 0, stale_files };
};
