import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeParse } from "../util/json.js";
import {
  legacyGraphRootDir,
  projectsRegistryPath,
  type RepoIdentityLike,
  type StorageLocationConfig,
} from "../core/paths.js";

// 0.1.10+ P9a: scan every repo that has Tokenomy state on disk. Two
// sources merge here:
//   1. Home-mode graphs at ~/.tokenomy/graphs/<repoId>/ — discovered
//      by readdir. Each entry's meta.json reveals the real repo path.
//   2. In-repo graphs registered via projects.json — repoRoot points
//      at the user's checkout, where <repoRoot>/.tokenomy-graph/
//      lives.
// Pre-0.1.10 `tokenomy report` only showed the cwd's repo, so users
// with 30+ tracked repos saw "1 repo" — the multi-repo bug.

export interface RepoSummary {
  repoId: string;
  repoPath: string;
  storage: "in-repo" | "home";
  last_build_at: string | null;
  node_count: number;
  edge_count: number;
  snapshot_bytes: number;
  integrity_ok: boolean;
  schema_version: number | null;
}

interface MinimalMeta {
  repo_id?: string;
  repo_path?: string;
  built_at?: string;
  node_count?: number;
  edge_count?: number;
  schema_version?: number;
}

interface MinimalIntegrity {
  mismatched?: number;
}

const summarize = (
  graphDir: string,
  storage: "in-repo" | "home",
  fallbackRepoId: string,
  fallbackRepoPath: string,
): RepoSummary | null => {
  const metaPath = join(graphDir, "meta.json");
  if (!existsSync(metaPath)) return null;
  let meta: MinimalMeta | undefined;
  try {
    meta = safeParse<MinimalMeta>(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
  if (!meta) return null;
  const snapPath = join(graphDir, "snapshot.json");
  let snapshotBytes = 0;
  if (existsSync(snapPath)) {
    try {
      snapshotBytes = statSync(snapPath).size;
    } catch {
      // best-effort
    }
  }
  let integrityOk = true;
  const integPath = join(graphDir, ".integrity.json");
  if (existsSync(integPath)) {
    try {
      const integ = safeParse<MinimalIntegrity>(readFileSync(integPath, "utf8"));
      if (integ && typeof integ.mismatched === "number" && integ.mismatched > 0) {
        integrityOk = false;
      }
    } catch {
      // best-effort
    }
  }
  return {
    repoId: typeof meta.repo_id === "string" ? meta.repo_id : fallbackRepoId,
    repoPath: typeof meta.repo_path === "string" ? meta.repo_path : fallbackRepoPath,
    storage,
    last_build_at: typeof meta.built_at === "string" ? meta.built_at : null,
    node_count: typeof meta.node_count === "number" ? meta.node_count : 0,
    edge_count: typeof meta.edge_count === "number" ? meta.edge_count : 0,
    snapshot_bytes: snapshotBytes,
    integrity_ok: integrityOk,
    schema_version: typeof meta.schema_version === "number" ? meta.schema_version : null,
  };
};

export const listGraphRepos = (): { repos: RepoSummary[]; unreadable_count: number } => {
  const repos: RepoSummary[] = [];
  let unreadable = 0;

  // Home-mode discovery.
  const homeRoot = legacyGraphRootDir();
  if (existsSync(homeRoot)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(homeRoot);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const dir = join(homeRoot, name);
      try {
        const st = statSync(dir);
        if (!st.isDirectory()) continue;
      } catch {
        continue;
      }
      const r = summarize(dir, "home", name, dir);
      if (r) repos.push(r);
      else unreadable++;
    }
  }

  // In-repo discovery via projects.json registry.
  const reg = projectsRegistryPath();
  if (existsSync(reg)) {
    let raw: string;
    try {
      raw = readFileSync(reg, "utf8");
    } catch {
      raw = "";
    }
    const seen = new Set(repos.map((r) => r.repoId));
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const entry = safeParse<{ repoId?: string; repoRoot?: string }>(line);
      // codex round 10 P2: a malformed registry row with
      // {"repoRoot":123} would otherwise reach `join(123, ...)` and
      // throw an Error("path must be a string") that crashed the
      // whole `tokenomy report` invocation. Skip silently instead.
      if (!entry || typeof entry.repoRoot !== "string" || entry.repoRoot.length === 0) {
        continue;
      }
      const dir = join(entry.repoRoot, ".tokenomy-graph");
      if (!existsSync(dir)) continue;
      const fallbackId = typeof entry.repoId === "string" ? entry.repoId : entry.repoRoot;
      if (seen.has(fallbackId)) continue;
      const r = summarize(dir, "in-repo", fallbackId, entry.repoRoot);
      if (r) {
        repos.push(r);
        seen.add(r.repoId);
      } else {
        unreadable++;
      }
    }
  }

  // Sort newest build first; unbuilt last.
  repos.sort((a, b) => {
    const ta = a.last_build_at ? Date.parse(a.last_build_at) : 0;
    const tb = b.last_build_at ? Date.parse(b.last_build_at) : 0;
    return tb - ta;
  });

  return { repos, unreadable_count: unreadable };
};
