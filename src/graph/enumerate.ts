import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, posix, relative } from "node:path";
import type { Config } from "../core/types.js";
import { compileGlobs, matchesAny } from "../util/glob.js";
import type { FailOpen } from "./types.js";

const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IGNORED_DIRS = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);

export interface EnumerateFilesOk {
  ok: true;
  files: string[];
  skipped_files: string[];
  source: "git" | "walk";
}

export type EnumerateFilesResult = EnumerateFilesOk | FailOpen;

export interface RawFileList {
  files: string[];
  source: "git" | "walk";
}

const toPosixRelative = (root: string, absPath: string): string =>
  relative(root, absPath).split("\\").join("/");

const isCodeFile = (relPath: string): boolean => {
  if (relPath.endsWith(".d.ts")) return false;
  const idx = relPath.lastIndexOf(".");
  if (idx === -1) return false;
  return CODE_EXTS.has(relPath.slice(idx));
};

const enumerateViaGit = (repoPath: string): string[] | null => {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: repoPath, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    return out
      .toString("utf8")
      .split("\u0000")
      .filter((entry) => entry.length > 0)
      .map((entry) => posix.normalize(entry));
  } catch {
    return null;
  }
};

const walkAll = (repoPath: string, dirPath: string, out: string[]): void => {
  let entries: Dirent[];
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkAll(repoPath, join(dirPath, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(posix.normalize(toPosixRelative(repoPath, join(dirPath, entry.name))));
  }
};

const enumerateViaWalk = (repoPath: string): string[] => {
  const files: string[] = [];
  walkAll(repoPath, repoPath, files);
  return files;
};

// Raw posix-relative file list for the repo, honoring IGNORED_DIRS on the walk
// path. No code-ext filter, no graph.exclude filter, no hard_max_files cap —
// downstream consumers apply those. Shared between enumerateGraphFiles (source
// files) and enumerateTsconfigs (tsconfig.json / jsconfig.json files) so a
// single stat-heavy walk covers both discovery needs per build / stale-check.
export const enumerateAllFiles = (repoPath: string): RawFileList => {
  const viaGit = enumerateViaGit(repoPath);
  if (viaGit !== null) return { files: viaGit, source: "git" };
  return { files: enumerateViaWalk(repoPath), source: "walk" };
};

// tsconfig / jsconfig discovery. Filename match only — callers verify existence
// before reading (git-ls-files may report tracked-but-missing paths).
export const enumerateTsconfigs = (repoPath: string): string[] =>
  enumerateTsconfigsFromList(enumerateAllFiles(repoPath).files);

// Same filter, but reusing a pre-computed raw file list so build/stale paths
// can share one enumeration across source-file discovery AND tsconfig discovery.
export const enumerateTsconfigsFromList = (rawFiles: readonly string[]): string[] => {
  const out: string[] = [];
  for (const rel of rawFiles) {
    // Reject node_modules even if git happened to track something there
    // (shouldn't normally happen, but be defensive).
    if (rel.startsWith("node_modules/") || rel.includes("/node_modules/")) continue;
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    if (
      base === "tsconfig.json" ||
      base === "jsconfig.json" ||
      (base.startsWith("tsconfig.") && base.endsWith(".json")) ||
      (base.startsWith("jsconfig.") && base.endsWith(".json"))
    ) {
      out.push(rel);
    }
  }
  return out.sort();
};

// Variant that accepts a pre-walked raw file list. Used by hot paths
// (build + stale check) that already paid for one git-ls-files / walk and
// want the code-filter + exclude pass without a second walk.
export const enumerateGraphFilesFromRaw = (
  repoPath: string,
  cfg: Config,
  raw: RawFileList,
): EnumerateFilesResult => {
  const excludeRegexes = compileGlobs(cfg.graph.exclude);
  const files = new Set<string>();
  const skipped: string[] = [];
  for (const candidate of raw.files) {
    if (!isCodeFile(candidate)) continue;
    const abs = join(repoPath, ...candidate.split("/"));
    if (!existsSync(abs)) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const rel = candidate;
    if (matchesAny(rel, excludeRegexes)) {
      skipped.push(rel);
      continue;
    }
    files.add(rel);
    if (files.size > cfg.graph.hard_max_files) {
      return { ok: false, reason: "repo-too-large" };
    }
  }
  return {
    ok: true,
    files: [...files].sort(),
    skipped_files: skipped.sort(),
    source: raw.source,
  };
};

export const enumerateGraphFiles = (repoPath: string, cfg: Config): EnumerateFilesResult => {
  const excludeRegexes = compileGlobs(cfg.graph.exclude);
  const raw = enumerateAllFiles(repoPath);
  const files = new Set<string>();
  const skipped: string[] = [];
  for (const candidate of raw.files) {
    if (!isCodeFile(candidate)) continue;
    const abs = join(repoPath, ...candidate.split("/"));
    if (!existsSync(abs)) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const rel = candidate;
    if (matchesAny(rel, excludeRegexes)) {
      skipped.push(rel);
      continue;
    }
    files.add(rel);
    if (files.size > cfg.graph.hard_max_files) {
      return { ok: false, reason: "repo-too-large" };
    }
  }
  return {
    ok: true,
    files: [...files].sort(),
    skipped_files: skipped.sort(),
    source: raw.source,
  };
};
