import type { Config } from "../../core/types.js";
import type { Confidence, Edge, Graph } from "../schema.js";
import { buildGraphIndex, projectNode, resolveTargetNode } from "./common.js";
import { clipResultToBudget, limitByCount } from "./budget.js";
import type { FindUsagesInput, FindUsagesResult, FindUsagesCallSite } from "../types.js";

// Edges that constitute a "usage" of a symbol: callers, references, and the
// importers of the file it lives in (since any import is effectively a
// cross-module usage signal).
const USAGE_EDGE_KINDS = new Set<Edge["kind"]>(["calls", "references", "imports"]);

export const findUsages = (
  graph: Graph,
  input: FindUsagesInput,
  cfg: Config,
  stale: boolean,
  stale_files: string[],
): FindUsagesResult => {
  const target = resolveTargetNode(graph, input.target.file, input.target.symbol);
  if (!target) return { ok: false, reason: "target-not-found" };

  const index = buildGraphIndex(graph);
  const callSites: FindUsagesCallSite[] = [];
  const seenSources = new Set<string>();

  // Direct incoming usage edges to the target (symbol-level usages).
  for (const edge of index.incoming.get(target.id) ?? []) {
    if (!USAGE_EDGE_KINDS.has(edge.kind)) continue;
    const source = index.nodesById.get(edge.from);
    if (!source || seenSources.has(source.id)) continue;
    seenSources.add(source.id);
    callSites.push({
      ...projectNode(source),
      edge_kind: edge.kind,
      confidence: edge.confidence,
    });
  }

  // If the target is a file-level node, also treat incoming `imports` on the
  // file itself as file-level usages (common for ES module graphs).
  if (target.kind === "file" || target.kind === "test-file") {
    for (const edge of index.incoming.get(target.id) ?? []) {
      if (edge.kind !== "imports") continue;
      const source = index.nodesById.get(edge.from);
      if (!source || seenSources.has(source.id)) continue;
      seenSources.add(source.id);
      callSites.push({
        ...projectNode(source),
        edge_kind: "imports",
        confidence: edge.confidence,
      });
    }
  }

  // Sort: definite first, then by edge-kind alpha, then by id for determinism.
  const confRank = (c: Confidence): number => (c === "definite" ? 0 : 1);
  callSites.sort((a, b) => {
    const c = confRank(a.confidence) - confRank(b.confidence);
    if (c !== 0) return c;
    const e = a.edge_kind.localeCompare(b.edge_kind);
    if (e !== 0) return e;
    return a.id.localeCompare(b.id);
  });

  return clipResultToBudget(
    {
      ok: true,
      stale,
      stale_files,
      data: {
        focal: projectNode(target),
        call_sites: limitByCount(callSites, 100),
        summary: `${callSites.length} usage(s) of ${target.name}`,
      },
    },
    cfg.graph.query_budget_bytes.find_usages,
  );
};
