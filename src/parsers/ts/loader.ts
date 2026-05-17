import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type * as TS from "typescript";
import type { FailOpen } from "../../graph/types.js";

export interface TypescriptLoaded {
  ok: true;
  ts: typeof TS;
  source: "bundled" | "repo-local";
}

export type TypescriptLoadResult = TypescriptLoaded | FailOpen;

interface CachedEntry {
  path: string;
  module: typeof TS;
  source: "bundled" | "repo-local";
}

let cached: CachedEntry | null = null;

const importResolved = async (resolvedPath: string): Promise<typeof TS> => {
  const imported = (await import(pathToFileURL(resolvedPath).href)) as typeof TS;
  return imported;
};

// 0.1.10+ PSEC2: TypeScript resolution order is now bundled-first to
// keep `tokenomy graph build` safe against a malicious
// `node_modules/typescript/index.js` in the target repo. Repo-local
// resolution is gated behind cfg.graph.allow_repo_local_typescript.
//
// Resolution order:
//   1. Process-local ("bundled"): Tokenomy's own node_modules or a
//      globally-installed typescript. Safe — controlled by the user
//      who installed Tokenomy.
//   2. Repo-local: only when options.allowRepoLocal === true. The repo's
//      own `node_modules/typescript` — convenient for unusual TS
//      versions but executes whatever index.js the repo provides.
//   3. typescript-not-installed.
export const loadTypescript = async (
  cwd: string,
  options: { allowRepoLocal?: boolean } = {},
): Promise<TypescriptLoadResult> => {
  const allowRepoLocal = options.allowRepoLocal === true;

  // Step 1: bundled / process-local.
  try {
    if (cached?.source === "bundled") return { ok: true, ts: cached.module, source: "bundled" };
    const imported = (await import("typescript")) as typeof TS;
    cached = { path: "process", module: imported, source: "bundled" };
    return { ok: true, ts: imported, source: "bundled" };
  } catch {
    // fall through
  }

  // Step 2: repo-local (opt-in).
  if (allowRepoLocal) {
    const requireFromHere = createRequire(import.meta.url);
    try {
      const resolved = requireFromHere.resolve("typescript", { paths: [cwd] });
      if (cached?.source === "repo-local" && cached.path === resolved) {
        return { ok: true, ts: cached.module, source: "repo-local" };
      }
      const ts = await importResolved(resolved);
      cached = { path: resolved, module: ts, source: "repo-local" };
      return { ok: true, ts, source: "repo-local" };
    } catch {
      // fall through
    }
  }

  return {
    ok: false,
    reason: "typescript-not-installed",
    hint: allowRepoLocal
      ? "Install `typescript` alongside Tokenomy or in the target repo, then re-run `tokenomy graph build`."
      : "Install `typescript` alongside Tokenomy (or set `graph.allow_repo_local_typescript: true` to use the repo's own copy), then re-run `tokenomy graph build`.",
  };
};

// Test affordance — drop the cached loader between test cases.
export const _resetTypescriptLoaderForTests = (): void => {
  cached = null;
};
