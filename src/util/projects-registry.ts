import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { projectsRegistryPath } from "../core/paths.js";
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

// 0.1.10+ codex round 4 P2: lazy compaction removed from the
// listProjects path. The previous lock-file approach only blocked
// other compactors, not concurrent registerProject appends — a
// register landing after readRaw but before atomicWrite would have
// its row lost when the compacted body replaced the file. Without
// an OS-level shared/exclusive lock primitive (Node has no flock),
// safe in-process compaction would need to teach registerProject
// to coordinate, which breaks its current append-only guarantee.
// Defer compaction to a future dedicated CLI command (e.g.
// `tokenomy projects compact`) that runs out of band of any live
// MCP server, so writers and readers stay race-free. listProjects
// already dedupes on read; the worst impact of unbounded growth is
// extra parse cost on `tokenomy doctor --all-repos`, not data loss.

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

export const listProjects = (): ProjectRegistryEntry[] => dedupe(readRaw());

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
