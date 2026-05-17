import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
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
        quarantine(identity, cfg, snapPath, metaPath, "snapshot-sha-mismatch");
        return null;
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
    const snapFinal = graphSnapshotPath(identity, cfg);
    const metaFinal = graphMetaPath(identity, cfg);
    renameSync(snapTmp, snapFinal);
    renameSync(metaTmp, metaFinal);

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
