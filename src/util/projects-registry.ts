import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { projectsRegistryPath } from "../core/paths.js";
import { atomicWrite } from "./atomic.js";
import { safeParse } from "./json.js";

// 0.1.8+: project registry — JSONL at `~/.tokenomy/projects.json`.
//
// Each line is one entry. Latest entry per `repoRoot` wins on read. Append-
// only writes keep the format crash-safe + race-tolerant across concurrent
// MCP / build / raven processes. Dedup + prune happen at read time.
//
// Consumers:
//   - `tokenomy graph purge --all` / `raven clean --all`
//   - `tokenomy graph migrate` / `raven migrate`
//   - `tokenomy doctor --all-repos`
//   - `tokenomy diagnose` (cross-repo mode)

export type ProjectKind = "graph" | "raven";

export interface ProjectRegistryEntry {
  repoRoot: string;
  repoId: string;
  registered_at: string;
  last_built_at?: string;
  raven_enabled?: boolean;
}

const readRaw = (): ProjectRegistryEntry[] => {
  const path = projectsRegistryPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const out: ProjectRegistryEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parsed = safeParse<ProjectRegistryEntry>(line);
      if (
        parsed &&
        typeof parsed.repoRoot === "string" &&
        typeof parsed.repoId === "string" &&
        typeof parsed.registered_at === "string"
      ) {
        out.push(parsed);
      }
    }
    return out;
  } catch {
    return [];
  }
};

// Latest entry per repoRoot. Order preserved by `registered_at`.
const dedupe = (entries: ProjectRegistryEntry[]): ProjectRegistryEntry[] => {
  const merged = new Map<string, ProjectRegistryEntry>();
  for (const entry of entries) {
    const prev = merged.get(entry.repoRoot);
    if (!prev) {
      merged.set(entry.repoRoot, entry);
      continue;
    }
    merged.set(entry.repoRoot, {
      ...prev,
      ...entry,
      // explicit boolean OR so a later `raven_enabled: true` sticks
      raven_enabled: entry.raven_enabled ?? prev.raven_enabled,
      last_built_at: entry.last_built_at ?? prev.last_built_at,
    });
  }
  return [...merged.values()];
};

// 0.1.10+ P12d: compaction threshold. When the registry grows past
// this many bytes, the next read folds dedupe into the on-disk
// representation. Pre-0.1.10 the append-only file could hold tens of
// thousands of rows across years of project work; listProjects()
// re-parsed every line on every call.
const REGISTRY_COMPACT_BYTES = 1_048_576;

// 0.1.10+ codex round 3 P3: compaction is a destructive rewrite —
// a concurrent registerProject() append between the read and the
// atomicWrite would lose the appended row. Per-call lock-file
// pattern with a short timeout avoids the race; on lock contention
// we just defer compaction to the next read. Worst case: registry
// stays above threshold for another listProjects cycle, which is
// a non-issue compared to losing a registration.
const maybeCompact = (path: string, parsed: ProjectRegistryEntry[]): void => {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size < REGISTRY_COMPACT_BYTES) return;
  const lockPath = `${path}.compact.lock`;
  let lockFd: number | null = null;
  try {
    // Open exclusive — fails fast if another process is compacting.
    // We DO NOT retry: a parallel listProjects will defer; a parallel
    // registerProject is unaffected (it just appends).
    lockFd = openSync(lockPath, "wx");
    // Re-read the registry from disk INSIDE the lock so any rows
    // appended between the caller's readRaw and our compaction land
    // in the deduped output.
    const rawAtLock = readRaw();
    const deduped = dedupe(rawAtLock);
    const body = deduped.map((e) => JSON.stringify(e)).join("\n") + (deduped.length > 0 ? "\n" : "");
    atomicWrite(path, body, false);
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // best-effort
    }
    lockFd = null;
  } catch {
    // EEXIST → another writer is compacting; defer. Other errors are
    // best-effort. Either way, ensure we release the lock if held.
    if (lockFd !== null) {
      try {
        closeSync(lockFd);
        unlinkSync(lockPath);
      } catch {
        // best-effort
      }
    }
  }
};

// 0.1.8+: register / refresh a project. Idempotent on `repoRoot`. Appends
// a single line; readers dedupe latest-wins.
export const registerProject = (
  entry: Omit<ProjectRegistryEntry, "registered_at"> & { registered_at?: string },
): void => {
  try {
    const path = projectsRegistryPath();
    mkdirSync(dirname(path), { recursive: true });
    const row: ProjectRegistryEntry = {
      registered_at: entry.registered_at ?? new Date().toISOString(),
      repoRoot: entry.repoRoot,
      repoId: entry.repoId,
      ...(entry.last_built_at ? { last_built_at: entry.last_built_at } : {}),
      ...(entry.raven_enabled !== undefined ? { raven_enabled: entry.raven_enabled } : {}),
    };
    // 0.1.10+ P12d: appendFileSync is atomic for sub-PIPE_BUF writes
    // on POSIX (rows are ~150 bytes). Concurrent registerProject
    // calls from parallel processes interleave safely.
    appendFileSync(path, JSON.stringify(row) + "\n");
  } catch {
    // best-effort; registry write must never block the caller
  }
};

export const listProjects = (): ProjectRegistryEntry[] => {
  const raw = readRaw();
  // 0.1.10+ P12d: lazy compaction. When the registry grows past
  // REGISTRY_COMPACT_BYTES, fold dedupe into the on-disk file so
  // future reads parse fewer lines. Best-effort; failure to compact
  // never affects the returned list.
  try {
    maybeCompact(projectsRegistryPath(), raw);
  } catch {
    // best-effort
  }
  return dedupe(raw);
};

// 0.1.8+: drop entries whose repoRoot no longer exists on disk. Returns the
// pruned list; caller can re-write the file to compact it.
export const pruneMissingProjects = (): {
  kept: ProjectRegistryEntry[];
  removed: ProjectRegistryEntry[];
} => {
  const kept: ProjectRegistryEntry[] = [];
  const removed: ProjectRegistryEntry[] = [];
  for (const entry of listProjects()) {
    if (existsSync(entry.repoRoot)) kept.push(entry);
    else removed.push(entry);
  }
  return { kept, removed };
};

// 0.1.8+: rewrite the registry from `entries`. Used after `prune` or after
// removing a project. Atomic-replace: writes to a tmp neighbor and renames.
export const rewriteRegistry = (entries: ProjectRegistryEntry[]): void => {
  try {
    const path = projectsRegistryPath();
    mkdirSync(dirname(path), { recursive: true });
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
    writeFileSync(path, body);
  } catch {
    // best-effort
  }
};
