import type { Config } from "../../core/types.js";
import type { Graph, Edge } from "../schema.js";
import type {
  MinimalContextInput,
  MinimalContextNeighbor,
  MinimalContextResult,
} from "../types.js";
import { buildGraphIndex, projectNode, resolveTargetNode } from "./common.js";
import { clipResultToBudget, limitByCount } from "./budget.js";

// 0.1.8+: edge priority drives both the BFS order (so the most-useful
// neighbors fill the 64-node visit budget first) AND the final sort.
// "imports/references/calls" are usually what the user actually wants
// to see; "contains" buries the answer under the focal's own children
// on hub files like a top-level barrel index.
const EDGE_PRIORITY: Record<Edge["kind"], number> = {
  imports: 0,
  references: 1,
  calls: 2,
  exports: 3,
  tests: 4,
  contains: 5,
};

export const minimalContext = (
  graph: Graph,
  input: MinimalContextInput,
  cfg: Config,
  stale: boolean,
  stale_files: string[],
): MinimalContextResult => {
  const target = resolveTargetNode(graph, input.target.file, input.target.symbol);
  if (!target) return { ok: false, reason: "target-not-found" };

  const depthLimit = Math.max(1, Math.min(2, input.depth ?? 1));
  const index = buildGraphIndex(graph);
  const visited = new Set<string>([target.id]);
  // 0.1.8+: priority queue (min-heap-on-array — pq is small). Enqueue every
  // outgoing/incoming edge with a key from EDGE_PRIORITY × depth, then
  // dequeue lowest-key-first so high-utility edges win the visit budget.
  const pq: Array<{ id: string; depth: number; key: number; edge: Edge; direction: "in" | "out" }> = [];
  const enqueue = (id: string, depth: number, edge: Edge, direction: "in" | "out"): void => {
    const key = EDGE_PRIORITY[edge.kind] * 100 + depth;
    let i = pq.length;
    pq.push({ id, depth, key, edge, direction });
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pq[parent]!.key <= pq[i]!.key) break;
      [pq[parent], pq[i]] = [pq[i]!, pq[parent]!];
      i = parent;
    }
  };
  const dequeue = (): { id: string; depth: number; edge: Edge; direction: "in" | "out" } | undefined => {
    if (pq.length === 0) return undefined;
    const top = pq[0]!;
    const last = pq.pop()!;
    if (pq.length > 0) {
      pq[0] = last;
      let i = 0;
      const n = pq.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && pq[l]!.key < pq[smallest]!.key) smallest = l;
        if (r < n && pq[r]!.key < pq[smallest]!.key) smallest = r;
        if (smallest === i) break;
        [pq[i], pq[smallest]] = [pq[smallest]!, pq[i]!];
        i = smallest;
      }
    }
    return top;
  };

  // Seed with the focal's direct neighbors.
  for (const edge of index.outgoing.get(target.id) ?? []) enqueue(edge.to, 1, edge, "out");
  for (const edge of index.incoming.get(target.id) ?? []) enqueue(edge.from, 1, edge, "in");

  const neighbors: MinimalContextNeighbor[] = [];
  while (pq.length > 0 && visited.size < 64) {
    const cur = dequeue()!;
    if (visited.has(cur.id)) continue;
    const node = index.nodesById.get(cur.id);
    if (!node) continue;
    visited.add(node.id);
    neighbors.push({
      ...projectNode(node),
      edge_kind: cur.edge.kind,
      direction: cur.direction,
      confidence: cur.edge.confidence,
      depth: cur.depth,
    });
    if (cur.depth < depthLimit) {
      for (const e of index.outgoing.get(node.id) ?? []) {
        if (!visited.has(e.to)) enqueue(e.to, cur.depth + 1, e, "out");
      }
      for (const e of index.incoming.get(node.id) ?? []) {
        if (!visited.has(e.from)) enqueue(e.from, cur.depth + 1, e, "in");
      }
    }
  }

  neighbors.sort((a, b) => {
    const conf = Number(a.confidence === "inferred") - Number(b.confidence === "inferred");
    if (conf !== 0) return conf;
    const edge = EDGE_PRIORITY[a.edge_kind as Edge["kind"]] - EDGE_PRIORITY[b.edge_kind as Edge["kind"]];
    if (edge !== 0) return edge;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.id.localeCompare(b.id);
  });

  return clipResultToBudget(
    {
      ok: true,
      stale,
      stale_files,
      data: {
        focal: projectNode(target),
        neighbors: limitByCount(neighbors, 40),
        hint: `If this is insufficient, try get_impact_radius or Read ${input.target.file}`,
      },
    },
    cfg.graph.query_budget_bytes.get_minimal_context,
  );
};
