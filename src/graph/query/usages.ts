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

  // Cross-module traversal for symbol-focal queries. The extractor emits
  // `calls` / `references` edges terminating at the LOCAL imported-symbol
  // node in the caller file (not at the definition). To surface real call
  // sites, we walk: focal's file -> incoming imports edges -> imported-symbol
  // nodes whose `original_name` equals focal.name -> incoming calls/references.
  //
  // Gated on `target.exported === true`: non-exported locals (e.g. private
  // method `C.foo`) cannot be reached cross-module by name, so allowing the
  // traversal would false-positively credit any unrelated exported `foo` in
  // the same file. An exported-symbol node is always eligible.
  //
  // Two-pass order matters: cross-module callers are collected BEFORE
  // file-level importers so a top-level call (where the caller is the file
  // node itself) isn't masked by a file-level import placeholder.
  // A focal is eligible for cross-module callers when the graph shows it's
  // reachable externally: it's an exported-symbol placeholder itself, it has
  // the explicit `exported: true` flag (set by the extractor on some paths),
  // or there's an incoming `exports` edge from an exp: placeholder pointing
  // at it (the canonical signal for top-level `export function foo` in the
  // TS extractor — see src/parsers/ts/extract.ts:266).
  const isExportedFocal =
    target.kind === "exported-symbol" ||
    target.exported === true ||
    (index.incoming.get(target.id) ?? []).some((e) => e.kind === "exports");
  if (
    isExportedFocal &&
    target.kind !== "file" &&
    target.kind !== "test-file" &&
    typeof target.file === "string"
  ) {
    const fileNodeId = `file:${target.file}`;
    const fileIncoming = index.incoming.get(fileNodeId) ?? [];

    // Pass 1: walk imported-symbol nodes matching focal.original_name and
    // collect their real callers (functions / files that invoke the import).
    for (const importEdge of fileIncoming) {
      if (importEdge.kind !== "imports") continue;
      const source = index.nodesById.get(importEdge.from);
      if (!source || source.kind !== "imported-symbol") continue;
      // Match STRICTLY on original export name (set by extractor for named
      // imports only — default/namespace/ImportEquals/CJS have no original_name
      // and are correctly skipped to avoid name-collision false positives).
      // Legacy graphs (alpha.14 and earlier) lack original_name and fall
      // through here; users who need correctness should rebuild with --force.
      if (!source.original_name) continue;
      if (source.original_name !== target.name) continue;
      const callerEdges = index.incoming.get(source.id) ?? [];
      for (const callerEdge of callerEdges) {
        if (callerEdge.kind !== "calls" && callerEdge.kind !== "references") continue;
        const caller = index.nodesById.get(callerEdge.from);
        if (!caller || seenSources.has(caller.id)) continue;
        seenSources.add(caller.id);
        callSites.push({
          ...projectNode(caller),
          edge_kind: callerEdge.kind,
          confidence: callerEdge.confidence,
        });
      }
    }

    // Pass 2: file-level importers that didn't already surface as callers.
    // (`file:B -> file:A imports` is a signal even without a named call —
    // e.g. side-effect imports or re-exports.)
    for (const importEdge of fileIncoming) {
      if (importEdge.kind !== "imports") continue;
      const source = index.nodesById.get(importEdge.from);
      if (!source) continue;
      if (source.kind === "imported-symbol") continue;
      if (seenSources.has(source.id)) continue;
      seenSources.add(source.id);
      callSites.push({
        ...projectNode(source),
        edge_kind: "imports",
        confidence: importEdge.confidence,
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
