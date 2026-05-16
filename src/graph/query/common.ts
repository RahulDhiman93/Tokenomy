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
  const graph = store.loadGraph(identity, config.graph);
  const meta = store.loadMeta(identity, config.graph);
  if (!graph || !meta) return readLastGraphBuildFailure(identity, config.graph) ?? fail("graph-not-built");

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

// 0.1.9+: scope whole-graph stale_files down to the files this query
// actually touches. `reachable` is the set of files visited while
// building the answer (focal, neighbors, importers, etc.).
//
// 0.1.9+ codex round 2 P2: `stale` is CONSERVATIVE — true whenever
// ANY whole-graph drift exists. Reason: the reachable set is built
// from the OLD snapshot; an edit can add new edges that the snapshot
// can't show, so scoping alone can miss new dependencies.
//
// 0.1.9+ codex round 3 P2: also honor the caller's `inputStale`
// flag. Whole-graph invalidations (exclude_fingerprint or
// tsconfig_fingerprint changed) return `stale: true` with
// `stale_files: []` from `getGraphStaleStatus`. Without this
// preservation, those cases would report `stale: false` and serve
// the old snapshot as fresh.
//
// `stale_in_scope` remains the precise "files known stale AND known
// reachable" subset that callers can use to decide whether the
// drift is worth a re-query.
export const scopeStale = (
  inputStale: boolean,
  stale_files: string[],
  reachable: Iterable<string>,
): {
  stale: boolean;
  stale_in_scope: string[];
  whole_graph_stale: boolean;
} => {
  if (stale_files.length === 0) {
    // No granular drift list: trust the caller's stale flag.
    // codex round 9 P2: `stale: true` here is WHOLE-GRAPH stale
    // (exclude/tsconfig fingerprint flip, config-file edit, parse-
    // empty sentinel). Expose that distinctly so agents don't
    // treat it as "unrelated drift, low risk".
    return {
      stale: inputStale,
      stale_in_scope: [],
      whole_graph_stale: inputStale,
    };
  }
  const reachSet = reachable instanceof Set ? reachable : new Set(reachable);
  const hits: string[] = [];
  for (const f of stale_files) if (reachSet.has(f)) hits.push(f);
  hits.sort();
  // Drift exists → stale is true (conservative). Caller's flag is
  // already true here by construction (stale_files non-empty implies
  // stale_status.stale = true), so OR'ing is a no-op but explicit.
  return {
    stale: inputStale || true,
    stale_in_scope: hits,
    whole_graph_stale: false,
  };
};

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
