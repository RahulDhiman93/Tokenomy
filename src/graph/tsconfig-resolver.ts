import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve as pathResolve } from "node:path";
import type * as TS from "typescript";
import { stableStringify } from "../util/json.js";
import { enumerateTsconfigsFromList } from "./enumerate.js";
import type { ResolveImportTarget } from "./resolve.js";

// Public resolver contract consumed by the extractor. Returns null when the
// tsconfig-path-alias machinery has nothing to say about a given specifier —
// caller falls through to the existing `resolveSpecifier` (which produces an
// `external-module` node for bare imports like "react", etc.).
//
// Fingerprinting lives in `./tsconfig-fingerprint.ts` (sync, content-based,
// no TS dependency) so the MCP read-side stale check can invalidate on
// tsconfig edits without loading TypeScript.
export interface TsconfigResolver {
  resolve(importerFile: string, specifier: string): ResolveImportTarget | null;
}

interface ParsedTsconfig {
  path: string; // absolute
  options: TS.CompilerOptions;
  resolutionCache: TS.ModuleResolutionCache;
}

const normalizePosixRel = (repoPath: string, absPath: string): string | null => {
  const rel = relative(repoPath, absPath).split("\\").join("/");
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return posix.normalize(rel);
};

const toAbsolute = (repoPath: string, relFile: string): string =>
  isAbsolute(relFile) ? relFile : pathResolve(repoPath, relFile);

// Parse one tsconfig via TS's native API. `parseJsonConfigFileContent` walks
// the `extends` chain (including `@tsconfig/*` via node_modules) and returns
// a normalized CompilerOptions that subsumes all inherited state — so we get
// correct alias resolution AND a single options object to fingerprint.
const parseTsconfig = (
  tsconfigAbsPath: string,
  ts: typeof TS,
): { options: TS.CompilerOptions; resolutionCache: TS.ModuleResolutionCache } | null => {
  const raw = ts.readConfigFile(tsconfigAbsPath, ts.sys.readFile);
  if (raw.error) return null;
  const parsed = ts.parseJsonConfigFileContent(
    raw.config,
    ts.sys,
    dirname(tsconfigAbsPath),
  );
  // parseJsonConfigFileContent surfaces errors in `parsed.errors`; we only
  // abort on genuinely fatal ones (unreadable extends chain). Non-fatal
  // warnings still let resolution work.
  if (parsed.errors.some((e) => e.category === ts.DiagnosticCategory.Error && e.code === 5083)) {
    return null;
  }
  const getCanonical: (s: string) => string = ts.sys.useCaseSensitiveFileNames
    ? (s) => s
    : (s) => s.toLowerCase();
  const resolutionCache = ts.createModuleResolutionCache(
    dirname(tsconfigAbsPath),
    getCanonical,
    parsed.options,
  );
  return { options: parsed.options, resolutionCache };
};

// Nearest-parent discovery must not pick auxiliary variants like
// `tsconfig.app.json` / `tsconfig.build.json` / `tsconfig.spec.json` when a
// canonical `tsconfig.json` (or `jsconfig.json`) lives in the same directory.
// Angular / Vue / Nx-style repos commonly ship several variants; only the
// canonical one defines the `paths` the editor actually uses. Variants are
// still included in the fingerprint (see tsconfig-fingerprint.ts) so edits
// to them invalidate the graph — they just don't govern resolution.
const isGoverningTsconfig = (relPath: string): boolean => {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return base === "tsconfig.json" || base === "jsconfig.json";
};

export const createTsconfigResolver = (
  repoPath: string,
  files: ReadonlySet<string>,
  ts: typeof TS,
  rawFiles: readonly string[],
): TsconfigResolver => {
  const tsconfigRelPaths = enumerateTsconfigsFromList(rawFiles).filter(
    isGoverningTsconfig,
  );
  const tsconfigAbsPaths = tsconfigRelPaths
    .map((rel) => pathResolve(repoPath, rel))
    .filter((abs) => existsSync(abs));

  // Parse every discovered tsconfig once up-front so nearest-parent discovery
  // can pick from a known set and fingerprinting can hash their options.
  const parsedByAbs = new Map<string, ParsedTsconfig>();
  for (const abs of tsconfigAbsPaths) {
    const parsed = parseTsconfig(abs, ts);
    if (parsed) {
      parsedByAbs.set(abs, { path: abs, ...parsed });
    }
  }

  // Pre-sort tsconfigs by path-segment depth (descending) so nearest-parent
  // lookup picks the deepest containing config for any given file dir.
  const sortedTsconfigs = [...parsedByAbs.values()].sort(
    (a, b) => dirname(b.path).length - dirname(a.path).length,
  );

  // Cross-platform ancestor check: on Windows, `dirname()` returns paths with
  // backslashes, so a naive `startsWith(candidateDir + "/")` never matches a
  // nested file. Normalize both sides to forward slashes before comparing.
  const toForwardSlash = (p: string): string => p.split("\\").join("/");
  const tsconfigForDir = new Map<string, ParsedTsconfig | null>();
  const findTsconfigForFile = (absFile: string): ParsedTsconfig | null => {
    const dir = dirname(absFile);
    const cached = tsconfigForDir.get(dir);
    if (cached !== undefined) return cached;
    const dirSlash = toForwardSlash(dir);
    // Pick the deepest tsconfig whose directory is `dir` or an ancestor.
    let hit: ParsedTsconfig | null = null;
    for (const candidate of sortedTsconfigs) {
      const candidateDirSlash = toForwardSlash(dirname(candidate.path));
      if (
        dirSlash === candidateDirSlash ||
        dirSlash.startsWith(candidateDirSlash + "/")
      ) {
        hit = candidate;
        break;
      }
    }
    tsconfigForDir.set(dir, hit);
    return hit;
  };

  // Layer-1 cache: memoize final (importerDir, specifier) → result per tsconfig.
  // Kills duplicate work for hot-imported symbols (a shared hook imported from
  // 20+ files pays resolution cost once per build).
  const resultCache = new Map<string, ResolveImportTarget | null>();

  const resolve = (importerFile: string, specifier: string): ResolveImportTarget | null => {
    // The extractor only calls us for non-relative, non-absolute specifiers.
    // Defensive re-check so this function is safe to call directly.
    if (specifier.startsWith(".") || specifier.startsWith("/")) return null;

    const importerAbs = toAbsolute(repoPath, importerFile);
    const tsc = findTsconfigForFile(importerAbs);
    if (!tsc) return null;

    const key = `${tsc.path}\0${dirname(importerAbs)}\0${specifier}`;
    if (resultCache.has(key)) return resultCache.get(key) ?? null;

    let resolved: TS.ResolvedModuleFull | undefined;
    try {
      const res = ts.resolveModuleName(
        specifier,
        importerAbs,
        tsc.options,
        ts.sys,
        tsc.resolutionCache,
      );
      resolved = res.resolvedModule;
    } catch {
      resolved = undefined;
    }
    if (!resolved) {
      resultCache.set(key, null);
      return null;
    }

    const resolvedAbs = resolved.resolvedFileName;
    const rel = normalizePosixRel(repoPath, resolvedAbs);
    // Resolved file is outside the repo root (e.g. node_modules through a
    // `paths` mapping) → caller falls through to external-module.
    if (!rel) {
      resultCache.set(key, null);
      return null;
    }
    // Resolved file is inside the repo but not in the enumerated `files` set
    // (e.g. filtered by graph.exclude) → caller falls through to
    // external-module. `find_usages` / `impact` only walk in-graph edges, so
    // crediting a usage to an excluded file would mislead.
    if (!files.has(rel)) {
      resultCache.set(key, null);
      return null;
    }
    const result: ResolveImportTarget = { kind: "file", target: rel };
    resultCache.set(key, result);
    return result;
  };

  return { resolve };
};

// Fingerprinting lives in `./tsconfig-fingerprint.ts` (sync, content-based,
// no TS dependency) so the MCP read-side stale check can invalidate on
// tsconfig edits without loading TypeScript.
