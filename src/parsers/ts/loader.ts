import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type * as TS from "typescript";
import type { FailOpen } from "../../graph/types.js";

export interface TypescriptLoaded {
  ok: true;
  ts: typeof TS;
}

export type TypescriptLoadResult = TypescriptLoaded | FailOpen;

let cachedPath: string | null = null;
let cachedModule: typeof TS | null = null;

const importResolved = async (resolvedPath: string): Promise<typeof TS> => {
  const imported = (await import(pathToFileURL(resolvedPath).href)) as typeof TS;
  return imported;
};

export const loadTypescript = async (
  cwd: string,
  options: { allowProcessResolver?: boolean } = {},
): Promise<TypescriptLoadResult> => {
  const allowProcessResolver =
    options.allowProcessResolver ?? process.env["TOKENOMY_DISABLE_GRAPH_TYPESCRIPT_FALLBACK"] !== "1";
  const requireFromHere = createRequire(import.meta.url);

  try {
    const resolved = requireFromHere.resolve("typescript", { paths: [cwd] });
    if (cachedPath === resolved && cachedModule) return { ok: true, ts: cachedModule };
    const ts = await importResolved(resolved);
    cachedPath = resolved;
    cachedModule = ts;
    return { ok: true, ts };
  } catch {
    // fall through
  }

  if (allowProcessResolver) {
    try {
      if (cachedPath === "process" && cachedModule) return { ok: true, ts: cachedModule };
      const imported = (await import("typescript")) as typeof TS;
      cachedPath = "process";
      cachedModule = imported;
      return { ok: true, ts: imported };
    } catch {
      // fall through
    }
  }

  return {
    ok: false,
    reason: "typescript-not-installed",
    hint:
      "Install `typescript` in the target repo or alongside Tokenomy, then re-run `tokenomy graph build`.",
  };
};
