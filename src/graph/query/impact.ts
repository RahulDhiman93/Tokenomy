import { basename } from "node:path";
import type { Config } from "../../core/types.js";
import type { Confidence, Edge, Graph } from "../schema.js";
import type {
  ImpactRadiusDependency,
  ImpactRadiusInput,
  ImpactRadiusResult,
} from "../types.js";
import { buildGraphIndex, projectNode, resolveTargetNode } from "./common.js";
import { clipResultToBudget, limitByCount } from "./budget.js";

const REVERSE_KINDS = new Set<Edge["kind"]>(["imports", "exports", "calls", "references"]);

const confidenceRank = (confidence: Confidence): number =>
  confidence === "definite" ? 0 : 1;

const collectSuggestedTests = (graph: Graph, reachedFiles: Set<string>): string[] => {
  const suggestions = new Set<string>();
  for (const node of graph.nodes) {
    if (node.kind !== "test-file" || !node.file) continue;
    for (const file of reachedFiles) {
      const base = basename(file).replace(/\.[^.]+$/, "");
      const testBase = basename(node.file).replace(/\.(test|spec)\.[^.]+$/, "");
      if (base === testBase) suggestions.add(node.file);
    }
  }
  return [...suggestions].sort();
};

export const impactRadius = (
  graph: Graph,
  input: ImpactRadiusInput,
  cfg: Config,
  stale: boolean,
  stale_files: string[],
): ImpactRadiusResult => {
  const maxDepth = Math.max(1, Math.min(3, input.max_depth ?? 2));
  const index = buildGraphIndex(graph);
  const seeds = new Set<string>();

  for (const changed of input.changed) {
    const fileNode = resolveTargetNode(graph, changed.file, undefined);
    if (fileNode) seeds.add(fileNode.id);
    for (const symbol of changed.symbols ?? []) {
      const target = resolveTargetNode(graph, changed.file, symbol);
      if (target) seeds.add(target.id);
    }
  }
  if (seeds.size === 0) return { ok: false, reason: "target-not-found" };

  const visited = new Map<string, { depth: number; confidence: Confidence }>();
  const queue: Array<{ id: string; depth: number; confidence: Confidence }> = [...seeds].map(
    (id) => ({ id, depth: 0, confidence: "definite" }),
  );
  const reverse_deps: ImpactRadiusDependency[] = [];
  const reachedFiles = new Set<string>();

  while (queue.length > 0 && visited.size < 512) {
    const current = queue.shift()!;
    const seen = visited.get(current.id);
    if (seen && seen.depth <= current.depth && confidenceRank(seen.confidence) <= confidenceRank(current.confidence)) {
      continue;
    }
    visited.set(current.id, { depth: current.depth, confidence: current.confidence });

    const incoming = index.incoming.get(current.id) ?? [];
    for (const edge of incoming) {
      if (!REVERSE_KINDS.has(edge.kind)) continue;
      const source = index.nodesById.get(edge.from);
      if (!source) continue;
      const nextDepth = current.depth + 1;
      if (nextDepth > maxDepth) continue;
      const nextConfidence: Confidence =
        current.confidence === "definite" && edge.confidence === "definite" ? "definite" : "inferred";
      queue.push({ id: source.id, depth: nextDepth, confidence: nextConfidence });

      if (!seeds.has(source.id)) {
        reverse_deps.push({
          ...projectNode(source),
          depth: nextDepth,
          confidence: nextConfidence,
        });
        if (source.file) reachedFiles.add(source.file);
      }
    }
  }

  reverse_deps.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    const conf = confidenceRank(a.confidence) - confidenceRank(b.confidence);
    if (conf !== 0) return conf;
    return a.id.localeCompare(b.id);
  });

  const suggested_tests = limitByCount(collectSuggestedTests(graph, reachedFiles), 20);
  return clipResultToBudget(
    {
      ok: true,
      stale,
      stale_files,
      data: {
        reverse_deps: limitByCount(reverse_deps, 80),
        suggested_tests,
        summary: `reverse deps: ${reverse_deps.length}, suggested tests: ${suggested_tests.length}`,
      },
    },
    cfg.graph.query_budget_bytes.get_impact_radius,
  );
};
