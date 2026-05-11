import type { Config } from "../../core/types.js";
import { resolveRepoId } from "../repo-id.js";
import type { Edge, Graph, GraphMeta, Node, NodeKind } from "../schema.js";
import { JsonGraphStore } from "../store.js";
import { getGraphStaleStatus } from "../stale.js";
import { readLastGraphBuildFailure } from "../build-log.js";
import type { FailOpen, QueryResult } from "../types.js";

export interface GraphQueryContext {
  graph: Graph;
  meta: GraphMeta;
  stale: boolean;
  stale_files: string[];
  repo_id: string;
  repo_path: string;
}

export interface GraphIndex {
  nodesById: Map<string, Node>;
  outgoing: Map<string, Edge[]>;
  incoming: Map<string, Edge[]>;
  byFile: Map<string, Node[]>;
}

export const fail = (reason: string, hint?: string): FailOpen => ({ ok: false, reason, hint });

export interface LoadGraphContextOptions {
  // When true, skip calling getGraphStaleStatus internally. The caller is
  // expected to have already computed staleness and pass it via precomputedStale.
  // Used by the MCP read-side auto-refresh path to avoid double-enumeration.
  skipStaleCheck?: boolean;
  precomputedStale?: { stale: boolean; stale_files: string[] };
}

export const loadGraphContext = (
  cwd: string,
  config: Config,
  options: LoadGraphContextOptions = {},
): QueryResult<GraphQueryContext> => {
  if (!config.graph.enabled) return fail("graph-disabled");
  const identity = resolveRepoId(cwd);
  const store = new JsonGraphStore();
  const graph = store.loadGraph(identity.repoId);
  const meta = store.loadMeta(identity.repoId);
  if (!graph || !meta) return readLastGraphBuildFailure(identity.repoId) ?? fail("graph-not-built");

  let staleFlag: boolean;
  let staleFiles: string[];

  if (options.skipStaleCheck && options.precomputedStale) {
    staleFlag = options.precomputedStale.stale;
    staleFiles = options.precomputedStale.stale_files;
  } else {
    const stale = getGraphStaleStatus(identity.repoPath, meta, config);
    if (!stale.ok) return stale;
    staleFlag = stale.stale;
    staleFiles = stale.stale_files;
  }

  return {
    ok: true,
    stale: staleFlag,
    stale_files: staleFiles,
    data: {
      graph,
      meta,
      stale: staleFlag,
      stale_files: staleFiles,
      repo_id: identity.repoId,
      repo_path: identity.repoPath,
    },
  };
};

// 0.1.8+: WeakMap-memoize the index on the graph reference. Pre-0.1.8
// every query (minimal/usages/impact/review) rebuilt the index from
// scratch — O(N+E) per call, ~50ms wasted on every cache miss. The
// MCP server's process-local cache plus the snapshot's stable identity
// means we can reuse the index across queries until the snapshot is
// reloaded (which produces a fresh `graph` reference).
const indexCache = new WeakMap<Graph, GraphIndex>();

export const buildGraphIndex = (graph: Graph): GraphIndex => {
  const cached = indexCache.get(graph);
  if (cached) return cached;

  const nodesById = new Map<string, Node>();
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  const byFile = new Map<string, Node[]>();

  for (const node of graph.nodes) {
    nodesById.set(node.id, node);
    if (node.file) {
      const bucket = byFile.get(node.file) ?? [];
      bucket.push(node);
      byFile.set(node.file, bucket);
    }
  }

  for (const edge of graph.edges) {
    const outBucket = outgoing.get(edge.from) ?? [];
    outBucket.push(edge);
    outgoing.set(edge.from, outBucket);

    const inBucket = incoming.get(edge.to) ?? [];
    inBucket.push(edge);
    incoming.set(edge.to, inBucket);
  }

  const index: GraphIndex = { nodesById, outgoing, incoming, byFile };
  indexCache.set(graph, index);
  return index;
};

export const projectNode = (node: Node): {
  id: string;
  kind: NodeKind;
  name: string;
  file?: string;
  line?: number;
} => ({
  id: node.id,
  kind: node.kind,
  name: node.name,
  ...(node.file ? { file: node.file } : {}),
  ...(node.range?.line ? { line: node.range.line } : {}),
});

// 0.1.8+: index-driven resolution. Pre-0.1.8 `resolveTargetNode` did two
// O(N) linear scans of `graph.nodes` on every find_usages / impact /
// minimal call — on a 3k-file graph that's ~100k node touches per query.
// Now the index pre-bucketed by file and by id, both lookups are O(1)
// + O(matches-in-file).
export const resolveTargetNode = (
  graph: Graph,
  file: string,
  symbol: string | undefined,
): Node | null => {
  const idx = buildGraphIndex(graph);
  const fileNode = idx.nodesById.get(`file:${file}`) ?? null;
  if (!symbol) return fileNode;

  const sameFile = idx.byFile.get(file) ?? [];
  let exactSymbol: Node | null = null;
  for (const node of sameFile) {
    if (
      (node.kind === "function" || node.kind === "class" || node.kind === "method") &&
      (node.name === symbol || node.id.includes(`#${symbol}@`) || node.id.includes(`.${symbol}@`))
    ) {
      exactSymbol = node;
      break;
    }
  }
  if (exactSymbol) return exactSymbol;

  let exported: Node | null = null;
  for (const node of sameFile) {
    if (node.kind === "exported-symbol" && node.name === symbol) {
      exported = node;
      break;
    }
  }
  return exported ?? fileNode;
};
