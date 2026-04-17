import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../core/types.js";
import type { GraphMeta } from "./schema.js";
import { enumerateGraphFiles } from "./enumerate.js";
import { sha256FileSync } from "./hash.js";
import type { FailOpen } from "./types.js";

export interface StaleStatus {
  ok: true;
  stale: boolean;
  stale_files: string[];
}

export type GraphStaleResult = StaleStatus | FailOpen;

export const getGraphStaleStatus = (
  repoPath: string,
  meta: GraphMeta,
  cfg: Config,
): GraphStaleResult => {
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
