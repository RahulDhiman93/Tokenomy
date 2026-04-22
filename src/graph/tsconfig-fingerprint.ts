import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve as pathResolve } from "node:path";
import { stableStringify } from "../util/json.js";
import { enumerateTsconfigsFromList } from "./enumerate.js";

// Sync tsconfig fingerprint helper — no TypeScript dependency. Hashes every
// tsconfig/jsconfig in the repo plus every file reached via `extends` chains
// (including `@tsconfig/*`-style package-provided bases resolved via Node's
// own module resolver).
//
// Why content-based rather than "post-extends-resolved CompilerOptions":
// stale checks run on the MCP read path where we can't afford an async TS
// load. Hashing raw content over-invalidates slightly (a comment-only edit
// to tsconfig invalidates the graph) but never under-invalidates, which is
// the correctness property we care about.

const stripJsonComments = (json: string): string => {
  // Naive but sufficient: TS jsonc accepts //-line and /* block */ comments,
  // plus trailing commas. We just need enough parseability to pull `extends`
  // out; if this ever fails we just skip the chain walk for that config.
  return json
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
};

const readSafely = (absPath: string): string | null => {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
};

const resolveExtendsTarget = (spec: string, fromDir: string): string | null => {
  // Relative or absolute path. TS allows dropping the `.json` suffix.
  if (spec.startsWith(".") || isAbsolute(spec)) {
    const direct = pathResolve(fromDir, spec);
    if (existsSync(direct)) return direct;
    if (!spec.endsWith(".json")) {
      const withExt = pathResolve(fromDir, `${spec}.json`);
      if (existsSync(withExt)) return withExt;
    }
    return null;
  }
  // Package specifier — e.g. `@tsconfig/node20`, `@tsconfig/node20/tsconfig.json`.
  try {
    const resolverBase = pathResolve(fromDir, "package.json");
    const r = createRequire(resolverBase);
    return r.resolve(spec);
  } catch {
    // Fall back to implicit /tsconfig.json suffix that some packages expose.
    try {
      const resolverBase = pathResolve(fromDir, "package.json");
      const r = createRequire(resolverBase);
      return r.resolve(`${spec}/tsconfig.json`);
    } catch {
      return null;
    }
  }
};

const collectExtendsChain = (
  tsconfigAbs: string,
  visited: Set<string>,
  out: Array<[string, string]>,
): void => {
  if (visited.has(tsconfigAbs)) return;
  visited.add(tsconfigAbs);

  const content = readSafely(tsconfigAbs);
  if (content === null) return;

  out.push([tsconfigAbs, createHash("sha256").update(content).digest("hex")]);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const extendsField = (parsed as Record<string, unknown>)["extends"];
  const extendsSpecs: string[] = Array.isArray(extendsField)
    ? extendsField.filter((v): v is string => typeof v === "string")
    : typeof extendsField === "string"
      ? [extendsField]
      : [];
  const baseDir = dirname(tsconfigAbs);
  for (const spec of extendsSpecs) {
    const resolved = resolveExtendsTarget(spec, baseDir);
    if (resolved) collectExtendsChain(resolved, visited, out);
  }
};

export const fingerprintTsconfigs = (
  repoPath: string,
  rawFiles: readonly string[],
): string => {
  const entryPoints = enumerateTsconfigsFromList(rawFiles)
    .map((rel) => pathResolve(repoPath, rel))
    .filter((abs) => existsSync(abs));

  const visited = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const abs of entryPoints) {
    collectExtendsChain(abs, visited, entries);
  }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(stableStringify(entries)).digest("hex");
};

// Sentinel used when graph.tsconfig.enabled is false. Distinct from any real
// content-based hash so toggling enabled ↔ disabled always invalidates the
// cached graph (stale check compares stored vs current fingerprint).
export const TSCONFIG_FINGERPRINT_DISABLED = "__tokenomy_tsconfig_disabled__";

export const computeTsconfigFingerprint = (
  repoPath: string,
  rawFiles: readonly string[],
  enabled: boolean,
): string =>
  enabled
    ? fingerprintTsconfigs(repoPath, rawFiles)
    : TSCONFIG_FINGERPRINT_DISABLED;
