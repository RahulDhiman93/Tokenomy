import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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

const toPosixRelative = (root: string, absPath: string): string =>
  relative(root, absPath).split("\\").join("/");

const isCodeFile = (relPath: string): boolean => {
  if (relPath.endsWith(".d.ts")) return false;
  const idx = relPath.lastIndexOf(".");
  if (idx === -1) return false;
  return CODE_EXTS.has(relPath.slice(idx));
};

const filterFiles = (
  repoPath: string,
  candidates: string[],
  cfg: Config,
  excludeRegexes: RegExp[],
): EnumerateFilesResult => {
  const files = new Set<string>();
  const skipped: string[] = [];
  for (const candidate of candidates) {
    if (!isCodeFile(candidate)) continue;
    const abs = join(repoPath, ...candidate.split("/"));
    if (!existsSync(abs)) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const rel = posix.normalize(candidate);
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
    source: "git",
  };
};

const enumerateViaGit = (
  repoPath: string,
  cfg: Config,
  excludeRegexes: RegExp[],
): EnumerateFilesResult => {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: repoPath, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] },
    );
    const candidates = out
      .toString("utf8")
      .split("\u0000")
      .filter((entry) => entry.length > 0);
    return filterFiles(repoPath, candidates, cfg, excludeRegexes);
  } catch {
    return { ok: false, reason: "git-unavailable" };
  }
};

const walkDir = (
  repoPath: string,
  dirPath: string,
  files: Set<string>,
  skipped: string[],
  cfg: Config,
  excludeRegexes: RegExp[],
): FailOpen | null => {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const nested = walkDir(
        repoPath,
        join(dirPath, entry.name),
        files,
        skipped,
        cfg,
        excludeRegexes,
      );
      if (nested) return nested;
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = posix.normalize(toPosixRelative(repoPath, join(dirPath, entry.name)));
    if (!isCodeFile(rel)) continue;
    if (matchesAny(rel, excludeRegexes)) {
      skipped.push(rel);
      continue;
    }
    files.add(rel);
    if (files.size > cfg.graph.hard_max_files) {
      return { ok: false, reason: "repo-too-large" };
    }
  }
  return null;
};

const enumerateViaWalk = (
  repoPath: string,
  cfg: Config,
  excludeRegexes: RegExp[],
): EnumerateFilesResult => {
  const files = new Set<string>();
  const skipped: string[] = [];
  const error = walkDir(repoPath, repoPath, files, skipped, cfg, excludeRegexes);
  if (error) return error;
  return {
    ok: true,
    files: [...files].sort(),
    skipped_files: skipped.sort(),
    source: "walk",
  };
};

export const enumerateGraphFiles = (repoPath: string, cfg: Config): EnumerateFilesResult => {
  const excludeRegexes = compileGlobs(cfg.graph.exclude);
  const viaGit = enumerateViaGit(repoPath, cfg, excludeRegexes);
  if (viaGit.ok) return viaGit;
  if (viaGit.reason !== "git-unavailable") return viaGit;
  return enumerateViaWalk(repoPath, cfg, excludeRegexes);
};
