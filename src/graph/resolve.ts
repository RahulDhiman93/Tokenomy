import { dirname, posix } from "node:path";

export interface ResolveImportTarget {
  kind: "file" | "external-module" | "missing-file";
  target: string;
  message?: string;
}

const PROBE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

// TS NodeNext ESM convention: authors write `.js` in imports but the actual
// source is `.ts`. Map each runtime extension to the TS equivalents we should try.
const JS_TO_TS_EXTS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

const cleanRepoRelative = (input: string): string | null => {
  const normalized = posix.normalize(input);
  if (normalized === "." || normalized.length === 0) return null;
  if (normalized.startsWith("../")) return null;
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
};

export const resolveSpecifier = (
  importerFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): ResolveImportTarget => {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return { kind: "external-module", target: specifier };
  }

  const base = specifier.startsWith("/")
    ? specifier.slice(1)
    : posix.join(dirname(importerFile), specifier);
  const normalized = cleanRepoRelative(base);
  if (!normalized) {
    return {
      kind: "missing-file",
      target: base.replace(/^\/+/, ""),
      message: `specifier escapes repo root: ${specifier}`,
    };
  }

  const candidates = new Set<string>();
  candidates.add(normalized);
  const currentExt = PROBE_EXTS.find((ext) => normalized.endsWith(ext));
  if (currentExt) {
    // Specifier already has an extension. If it's a runtime ext (.js/.jsx/.mjs/.cjs),
    // also try the TS equivalents — common in TS NodeNext projects.
    const swaps = JS_TO_TS_EXTS[currentExt] ?? [];
    const base = normalized.slice(0, -currentExt.length);
    for (const tsExt of swaps) {
      candidates.add(base + tsExt);
    }
  } else {
    for (const ext of PROBE_EXTS) {
      candidates.add(`${normalized}${ext}`);
      candidates.add(posix.join(normalized, `index${ext}`));
    }
  }

  for (const candidate of candidates) {
    if (files.has(candidate)) return { kind: "file", target: candidate };
  }

  const fallback =
    [...candidates].find((candidate) => PROBE_EXTS.some((ext) => candidate.endsWith(ext))) ??
    normalized;
  return {
    kind: "missing-file",
    target: fallback,
    message: `could not resolve ${specifier} from ${importerFile}`,
  };
};
