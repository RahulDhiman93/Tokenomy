import type { Config } from "../../core/types.js";
import type { Graph, Edge } from "../schema.js";
import type {
  MinimalContextInput,
  MinimalContextNeighbor,
  MinimalContextResult,
} from "../types.js";
import { buildGraphIndex, projectNode, resolveTargetNode } from "./common.js";
import { clipResultToBudget, limitByCount } from "./budget.js";

const EDGE_PRIORITY: Record<Edge["kind"], number> = {
  imports: 0,
  exports: 1,
  contains: 2,
  calls: 3,
  references: 4,
  tests: 5,
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
  const queue: Array<{ id: string; depth: number }> = [{ id: target.id, depth: 0 }];
  const neighbors: MinimalContextNeighbor[] = [];

  while (queue.length > 0 && visited.size < 64) {
    const current = queue.shift()!;
    if (current.depth >= depthLimit) continue;
    const outgoing = index.outgoing.get(current.id) ?? [];
    const incoming = index.incoming.get(current.id) ?? [];

    for (const edge of outgoing) {
      const node = index.nodesById.get(edge.to);
      if (!node || visited.has(node.id)) continue;
      visited.add(node.id);
      queue.push({ id: node.id, depth: current.depth + 1 });
      neighbors.push({
        ...projectNode(node),
        edge_kind: edge.kind,
        direction: "out",
        confidence: edge.confidence,
        depth: current.depth + 1,
      });
    }

    for (const edge of incoming) {
      const node = index.nodesById.get(edge.from);
      if (!node || visited.has(node.id)) continue;
      visited.add(node.id);
      queue.push({ id: node.id, depth: current.depth + 1 });
      neighbors.push({
        ...projectNode(node),
        edge_kind: edge.kind,
        direction: "in",
        confidence: edge.confidence,
        depth: current.depth + 1,
      });
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
