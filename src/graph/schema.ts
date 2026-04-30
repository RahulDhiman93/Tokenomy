export const GRAPH_SCHEMA_VERSION = 1;

export type NodeKind =
  | "file"
  | "external-module"
  | "function"
  | "class"
  | "method"
  | "exported-symbol"
  | "imported-symbol"
  | "test-file";

export type EdgeKind =
  | "imports"
  | "exports"
  | "contains"
  | "calls"
  | "references"
  | "tests";

export type Confidence = "definite" | "inferred";

export interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  file?: string;
  range?: { start: number; end: number; line: number };
  exported?: boolean;
  // For imported-symbol nodes: the name as declared in the source module's
  // export, when it differs from `name` (the local binding). Set for aliased
  // named imports like `import { foo as bar } from './mod'` — `name` is
  // "bar", `original_name` is "foo". `find_usages` matches on the original
  // export name to avoid crediting aliased imports to unrelated exports.
  original_name?: string;
}

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  confidence: Confidence;
  via?: string;
}

export interface Graph {
  schema_version: number;
  repo_id: string;
  nodes: Node[];
  edges: Edge[];
  parse_errors: { file: string; message: string }[];
}

export interface GraphMeta {
  schema_version: number;
  repo_id: string;
  repo_path: string;
  built_at: string;
  tokenomy_version: string;
  node_count: number;
  edge_count: number;
  file_hashes: Record<string, string>;
  file_mtimes: Record<string, number>;
  soft_cap: number;
  hard_cap: number;
  parse_error_count: number;
  skipped_files?: string[];
  exclude_fingerprint?: string;
  // sha256 over the extends-resolved CompilerOptions of every tsconfig/jsconfig
  // in the repo. Invalidates the cached graph when `paths` / `baseUrl` / any
  // base config in the extends chain changes. Optional for backwards-compat:
  // legacy (alpha.16 and earlier) meta files deserialize fine, and on first
  // post-upgrade build `undefined !== currentFingerprint` naturally marks
  // stale → one free rebuild on upgrade.
  tsconfig_fingerprint?: string;
}

export interface GraphBuildLogEntry {
  ts: string;
  repo_id: string;
  repo_path: string;
  built: boolean;
  node_count: number;
  edge_count: number;
  parse_error_count: number;
  duration_ms: number;
  reason?: string;
  hint?: string;
  skipped_files?: string[];
}

export const createFileNode = (file: string): Node => ({
  id: `file:${file}`,
  kind: "file",
  name: file,
  file,
});

export const createExternalModuleNode = (specifier: string): Node => ({
  id: `ext:${specifier}`,
  kind: "external-module",
  name: specifier,
});

const symbolRange = (
  start: number,
  end: number,
  line: number,
): NonNullable<Node["range"]> => ({ start, end, line });

export const createFunctionNode = (
  file: string,
  name: string,
  line: number,
  n: number,
  start: number,
  end: number,
): Node => ({
  id: `sym:${file}#${name}@${line}:${n}`,
  kind: "function",
  name,
  file,
  range: symbolRange(start, end, line),
});

export const createClassNode = (
  file: string,
  name: string,
  line: number,
  n: number,
  start: number,
  end: number,
): Node => ({
  id: `sym:${file}#${name}@${line}:${n}`,
  kind: "class",
  name,
  file,
  range: symbolRange(start, end, line),
});

export const createMethodNode = (
  file: string,
  className: string,
  name: string,
  line: number,
  n: number,
  start: number,
  end: number,
): Node => ({
  id: `sym:${file}#${className}.${name}@${line}:${n}`,
  kind: "method",
  name,
  file,
  range: symbolRange(start, end, line),
});

export const createImportedSymbolNode = (
  file: string,
  name: string,
  line: number,
  n: number,
  originalName?: string,
): Node => ({
  id: `imp:${file}#${name}@${line}:${n}`,
  kind: "imported-symbol",
  name,
  file,
  range: symbolRange(0, 0, line),
  // Always persist `original_name` when the extractor supplies it — including
  // the trivial case where originalName === name — so `find_usages` can
  // positively identify nodes that came from a named import as opposed to a
  // default/namespace/require-style import (where originalName is omitted and
  // the query must NOT credit the local binding to an export of the same name).
  ...(originalName ? { original_name: originalName } : {}),
});

export const createExportedSymbolNode = (file: string, name: string): Node => ({
  id: `exp:${file}#${name}`,
  kind: "exported-symbol",
  name,
  file,
  exported: true,
});

export const createTestFileNode = (file: string): Node => ({
  id: `test:${file}`,
  kind: "test-file",
  name: file,
  file,
});

export const isFileLikeNode = (node: Node): boolean =>
  node.kind === "file" || node.kind === "test-file";

export const isSymbolNode = (node: Node): boolean =>
  node.kind === "function" || node.kind === "class" || node.kind === "method";

const compareNodes = (a: Node, b: Node): number => a.id.localeCompare(b.id);

const compareEdges = (a: Edge, b: Edge): number =>
  a.from.localeCompare(b.from) ||
  a.to.localeCompare(b.to) ||
  a.kind.localeCompare(b.kind) ||
  a.confidence.localeCompare(b.confidence) ||
  (a.via ?? "").localeCompare(b.via ?? "");

const compareParseErrors = (
  a: { file: string; message: string },
  b: { file: string; message: string },
): number => a.file.localeCompare(b.file) || a.message.localeCompare(b.message);

export const normalizeGraph = (graph: Graph): Graph => {
  const nodes = [...new Map(graph.nodes.map((node) => [node.id, node])).values()].sort(compareNodes);
  const edges = [
    ...new Map(
      graph.edges.map((edge) => [
        `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.confidence}\u0000${edge.via ?? ""}`,
        edge,
      ]),
    ).values(),
  ].sort(compareEdges);
  const parse_errors = [
    ...new Map(
      graph.parse_errors.map((err) => [`${err.file}\u0000${err.message}`, err]),
    ).values(),
  ].sort(compareParseErrors);

  return {
    schema_version: GRAPH_SCHEMA_VERSION,
    repo_id: graph.repo_id,
    nodes,
    edges,
    parse_errors,
  };
};
