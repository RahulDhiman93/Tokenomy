import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  GRAPH_COMMIT_TEMP_PREFIX,
  graphCommitTempDir,
  graphCorruptDir,
  graphDir,
  graphIntegrityStatsPath,
  graphMetaPath,
  graphSnapshotPath,
  type RepoIdentityLike,
  type StorageLocationConfig,
} from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { safeParse, stableStringify } from "../util/json.js";
import {
  GRAPH_SCHEMA_VERSION,
  MAX_KNOWN_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  type Graph,
  type GraphMeta,
} from "./schema.js";

export interface GraphStore {
  loadGraph(identity: RepoIdentityLike, cfg?: StorageLocationConfig): Graph | null;
  loadMeta(identity: RepoIdentityLike, cfg?: StorageLocationConfig): GraphMeta | null;
  save(
    identity: RepoIdentityLike,
    graph: Graph,
    meta: GraphMeta,
    cfg?: StorageLocationConfig,
  ): void;
}

export const serializeGraphSnapshot = (graph: Graph): string => `${JSON.stringify(graph)}\n`;
export const serializeGraphMeta = (meta: GraphMeta): string => `${stableStringify(meta)}\n`;

const sha256OfString = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

const sha256OfFile = (path: string): string => {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
};

const isGraph = (value: unknown): value is Graph =>
  !!value &&
  typeof value === "object" &&
  Array.isArray((value as { nodes?: unknown }).nodes) &&
  Array.isArray((value as { edges?: unknown }).edges) &&
  Array.isArray((value as { parse_errors?: unknown }).parse_errors);

const isGraphMetaShape = (value: unknown): value is GraphMeta =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { repo_id?: unknown }).repo_id === "string" &&
  typeof (value as { repo_path?: unknown }).repo_path === "string" &&
  typeof (value as { built_at?: unknown }).built_at === "string";

const schemaVersionOf = (value: unknown): number | null => {
  if (!value || typeof value !== "object") return null;
  const v = (value as { schema_version?: unknown }).schema_version;
  return typeof v === "number" ? v : null;
};

interface IntegrityStats {
  verified: number;
  mismatched: number;
  quarantined_total: number;
  last_quarantine_at: string | null;
}

const readIntegrity = (path: string): IntegrityStats => {
  if (!existsSync(path)) {
    return { verified: 0, mismatched: 0, quarantined_total: 0, last_quarantine_at: null };
  }
  const parsed = safeParse<Partial<IntegrityStats>>(readFileSync(path, "utf8"));
  return {
    verified: typeof parsed?.verified === "number" ? parsed.verified : 0,
    mismatched: typeof parsed?.mismatched === "number" ? parsed.mismatched : 0,
    quarantined_total:
      typeof parsed?.quarantined_total === "number" ? parsed.quarantined_total : 0,
    last_quarantine_at:
      typeof parsed?.last_quarantine_at === "string" ? parsed.last_quarantine_at : null,
  };
};

const bumpIntegrity = (
  path: string,
  patch: (cur: IntegrityStats) => IntegrityStats,
): void => {
  try {
    atomicWrite(path, `${stableStringify(patch(readIntegrity(path)))}\n`, false);
  } catch {
    // best-effort — integrity counter mustn't crash the loader
  }
};

const quarantine = (
  identity: RepoIdentityLike,
  cfg: StorageLocationConfig | undefined,
  snapPath: string,
  metaPath: string,
  reason: string,
): void => {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(graphCorruptDir(identity, cfg), stamp);
  try {
    mkdirSync(dest, { recursive: true });
    if (existsSync(snapPath)) {
      try {
        renameSync(snapPath, join(dest, "snapshot.json"));
      } catch {
        // best-effort
      }
    }
    if (existsSync(metaPath)) {
      try {
        renameSync(metaPath, join(dest, "meta.json"));
      } catch {
        // best-effort
      }
    }
    try {
      atomicWrite(join(dest, "reason.txt"), `${reason}\n`, false);
    } catch {
      // best-effort
    }
  } catch {
    // best-effort
  }
  bumpIntegrity(graphIntegrityStatsPath(identity, cfg), (cur) => ({
    verified: cur.verified,
    mismatched: cur.mismatched + 1,
    quarantined_total: cur.quarantined_total + 1,
    last_quarantine_at: new Date().toISOString(),
  }));
};

// 0.1.10+ codex round 3 P2: retry/copy-fallback for the final commit
// rename. The temp file was just written via atomicWrite (which has
// its own retry posture), but the rename that swaps the live target
// is the only step a Windows antivirus / Search Indexer can crash
// late in the commit. Mirror the same 50/150/300ms backoff used in
// atomicWrite, with copyFile + unlink as the final fallback.
const COMMIT_RENAME_BACKOFF_MS = [50, 150, 300];
const isTransientRename = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return (
    typeof code === "string" &&
    (code === "EAGAIN" ||
      code === "EBUSY" ||
      code === "ETXTBSY" ||
      code === "EPERM" ||
      code === "EACCES" ||
      code === "EMFILE")
  );
};
const sleepSync = (ms: number): void => {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
};

const commitRename = (from: string, to: string): void => {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= COMMIT_RENAME_BACKOFF_MS.length; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (!isTransientRename(err) || attempt === COMMIT_RENAME_BACKOFF_MS.length) {
        break;
      }
      sleepSync(COMMIT_RENAME_BACKOFF_MS[attempt] ?? 0);
    }
  }
  // Fallback: copy + unlink. Less atomic than rename, but the snapshot
  // is already SHA-pinned in meta — a crash mid-copy still leaves the
  // loader's integrity check able to quarantine.
  try {
    copyFileSync(from, to);
    unlinkSync(from);
  } catch {
    throw lastErr ?? new Error(`commitRename: ${from} → ${to} failed`);
  }
};

// Best-effort: remove `.commit-<pid>-*` dirs in graphDir whose pid is
// no longer alive. Cheap (one readdir + N kill(0) syscalls). Called at
// the top of `save()` so a crashed prior build doesn't leave orphans.
const sweepOrphanCommitDirs = (
  identity: RepoIdentityLike,
  cfg: StorageLocationConfig | undefined,
): void => {
  const dir = graphDir(identity, cfg);
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(GRAPH_COMMIT_TEMP_PREFIX)) continue;
    const rest = name.slice(GRAPH_COMMIT_TEMP_PREFIX.length);
    const dashIdx = rest.indexOf("-");
    const pidStr = dashIdx > 0 ? rest.slice(0, dashIdx) : rest;
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (pid === process.pid) continue; // never sweep our own in-flight dir
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") alive = true;
    }
    if (alive) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
};

export class JsonGraphStore implements GraphStore {
  loadGraph(identity: RepoIdentityLike, cfg?: StorageLocationConfig): Graph | null {
    const snapPath = graphSnapshotPath(identity, cfg);
    const metaPath = graphMetaPath(identity, cfg);
    if (!existsSync(snapPath)) return null;

    let raw: string;
    try {
      raw = readFileSync(snapPath, "utf8");
    } catch {
      return null;
    }
    const parsed = safeParse<unknown>(raw);
    if (!isGraph(parsed)) {
      quarantine(identity, cfg, snapPath, metaPath, "snapshot-parse-failed");
      return null;
    }
    const version = schemaVersionOf(parsed);
    if (version === null) return null;
    if (version < MIN_SUPPORTED_SCHEMA_VERSION) {
      quarantine(identity, cfg, snapPath, metaPath, `snapshot-schema-version-${version}-below-min`);
      return null;
    }
    if (version > MAX_KNOWN_SCHEMA_VERSION) {
      process.stderr.write(
        `[tokenomy] snapshot schema_version=${version} > max known ${MAX_KNOWN_SCHEMA_VERSION}; attempting forward-compat parse\n`,
      );
    }

    // Integrity check: compare meta.snapshot_sha256 against the actual
    // bytes. Skip when meta lacks the field (pre-0.1.10 graph) — those
    // get rebuilt on first 0.1.10 invocation, not quarantined.
    let metaForCheck: unknown = null;
    if (existsSync(metaPath)) {
      try {
        metaForCheck = safeParse<unknown>(readFileSync(metaPath, "utf8"));
      } catch {
        metaForCheck = null;
      }
    }
    const declaredSha =
      metaForCheck &&
      typeof metaForCheck === "object" &&
      typeof (metaForCheck as { snapshot_sha256?: unknown }).snapshot_sha256 === "string"
        ? ((metaForCheck as { snapshot_sha256: string }).snapshot_sha256)
        : null;
    if (declaredSha !== null) {
      const actualSha = sha256OfString(raw);
      if (actualSha !== declaredSha) {
        // 0.1.10+ codex round 5 P2: in-flight paired commit detection.
        // The writer (save() above) creates <graphDir>/.commit-<pid>-*
        // BEFORE either rename and removes it AFTER both renames
        // complete. If such a dir exists at mismatch time, a writer
        // is mid-commit and quarantining would clobber a healthy
        // rebuild. Return null (treated as missing → caller rebuilds
        // or retries) instead.
        //
        // Pre-fix the 50ms sleep+recheck wasn't enough because
        // commitRename's own retry posture (50/150/300ms backoff)
        // can keep meta unrenamed for hundreds of milliseconds under
        // Windows AV / Search Indexer locks.
        const dir = graphDir(identity, cfg);
        let commitInFlight = false;
        try {
          for (const name of readdirSync(dir)) {
            if (!name.startsWith(GRAPH_COMMIT_TEMP_PREFIX)) continue;
            // 0.1.10+ codex round 6 P2: only treat the commit dir as
            // live when its pid is still alive. A crashed writer
            // leaves the dir behind; that's the exact case where the
            // mismatch IS real and should quarantine. Pre-fix the
            // check passed for orphan dirs too.
            const rest = name.slice(GRAPH_COMMIT_TEMP_PREFIX.length);
            const dashIdx = rest.indexOf("-");
            const pidStr = dashIdx > 0 ? rest.slice(0, dashIdx) : rest;
            const pid = Number.parseInt(pidStr, 10);
            if (!Number.isFinite(pid) || pid <= 0) continue;
            try {
              process.kill(pid, 0);
              commitInFlight = true;
              break;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "EPERM") {
                // Not our process but alive — treat as in-flight.
                commitInFlight = true;
                break;
              }
              // ESRCH (or anything else) → dead pid, orphan dir;
              // keep scanning for a live one.
            }
          }
        } catch {
          commitInFlight = false;
        }
        if (commitInFlight) {
          // Caller (loadGraphContext) treats null + meta-load also
          // null as "graph-not-built", which triggers a rebuild OR
          // retry on the next query. Either is safe; neither
          // quarantines healthy data.
          return null;
        }
        // No commit in flight — real corruption.
        quarantine(identity, cfg, snapPath, metaPath, "snapshot-sha-mismatch");
        return null;
      }
    } else if (
      metaForCheck &&
      typeof metaForCheck === "object" &&
      isGraphMetaShape(metaForCheck)
    ) {
      // 0.1.10+ codex round 3 P2: pre-0.1.10 meta lacks
      // snapshot_sha256. Backfill the missing field by computing
      // the SHA over current bytes and atomically rewriting the
      // meta. Future loads then run the full integrity check.
      // Pre-fix, legacy graphs were served indefinitely without
      // ever writing a SHA — the new quarantine path stayed
      // disabled for upgraded users until an unrelated rebuild.
      try {
        const computedSha = sha256OfString(raw);
        const upgraded: GraphMeta = {
          ...(metaForCheck as GraphMeta),
          snapshot_sha256: computedSha,
        };
        atomicWrite(metaPath, `${stableStringify(upgraded)}\n`, false);
      } catch {
        // best-effort — failure to backfill leaves the legacy
        // meta in place; the next load attempts again.
      }
    }

    bumpIntegrity(graphIntegrityStatsPath(identity, cfg), (cur) => ({
      verified: cur.verified + 1,
      mismatched: cur.mismatched,
      quarantined_total: cur.quarantined_total,
      last_quarantine_at: cur.last_quarantine_at,
    }));
    return parsed;
  }

  loadMeta(identity: RepoIdentityLike, cfg?: StorageLocationConfig): GraphMeta | null {
    const metaPath = graphMetaPath(identity, cfg);
    const snapPath = graphSnapshotPath(identity, cfg);
    if (!existsSync(metaPath)) return null;

    const parsed = safeParse<unknown>(readFileSync(metaPath, "utf8"));
    if (!isGraphMetaShape(parsed)) return null;

    const version = schemaVersionOf(parsed);
    if (version === null) return null;
    if (version < MIN_SUPPORTED_SCHEMA_VERSION) {
      quarantine(identity, cfg, snapPath, metaPath, `meta-schema-version-${version}-below-min`);
      return null;
    }
    if (version > MAX_KNOWN_SCHEMA_VERSION) {
      process.stderr.write(
        `[tokenomy] meta schema_version=${version} > max known ${MAX_KNOWN_SCHEMA_VERSION}; attempting forward-compat parse\n`,
      );
    }

    // Cross-repo guard: a meta whose repo_id doesn't match the current
    // identity means someone copied .tokenomy-graph between repos.
    // Quarantine so the next build runs fresh against this repo.
    if ((parsed as GraphMeta).repo_id !== identity.repoId) {
      quarantine(identity, cfg, snapPath, metaPath, "meta-repo-id-mismatch");
      return null;
    }

    return parsed as GraphMeta;
  }

  save(
    identity: RepoIdentityLike,
    graph: Graph,
    meta: GraphMeta,
    cfg?: StorageLocationConfig,
  ): void {
    sweepOrphanCommitDirs(identity, cfg);

    const rand = Math.random().toString(36).slice(2, 10);
    const commitDir = graphCommitTempDir(identity, cfg, process.pid, rand);
    mkdirSync(commitDir, { recursive: true });

    const snapTmp = join(commitDir, "snapshot.json");
    const metaTmp = join(commitDir, "meta.json");

    const snapBody = serializeGraphSnapshot(graph);
    atomicWrite(snapTmp, snapBody, false);
    const snapSha = sha256OfString(snapBody);

    const metaWithSha: GraphMeta = { ...meta, snapshot_sha256: snapSha };
    atomicWrite(metaTmp, serializeGraphMeta(metaWithSha), false);

    // Sequential rename — snapshot first, then meta. If we crash between
    // them, the loader sees a fresh snapshot whose SHA the stale meta no
    // longer references; integrity check quarantines, build re-runs.
    //
    // codex round 3 P2: wrap each rename in retry-with-copy-fallback so
    // an antivirus / Windows Search Indexer holding the live target
    // open doesn't crash the commit. Mirrors atomicWrite's posture
    // for the rename phase since these are the only ones that touch
    // the canonical files.
    const snapFinal = graphSnapshotPath(identity, cfg);
    const metaFinal = graphMetaPath(identity, cfg);
    commitRename(snapTmp, snapFinal);
    commitRename(metaTmp, metaFinal);

    try {
      rmSync(commitDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// Test affordance — clear orphan dirs and reset integrity counters.
export const _resetIntegrityForTests = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): void => {
  try {
    rmSync(graphIntegrityStatsPath(identity, cfg), { force: true });
  } catch {
    // best-effort
  }
};

// Suppress unused-export tsc warning when only the type is referenced.
export type _StoreSchemaVersionExport = typeof GRAPH_SCHEMA_VERSION;
