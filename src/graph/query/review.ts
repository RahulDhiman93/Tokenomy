import type { Config } from "../../core/types.js";
import type { Graph } from "../schema.js";
import type { ReviewContextInput, ReviewContextResult } from "../types.js";
import { buildGraphIndex, scopeStale } from "./common.js";
import { clipResultToBudget, limitByCount } from "./budget.js";

export const reviewContext = (
  graph: Graph,
  input: ReviewContextInput,
  cfg: Config,
  // 0.1.9+: caller's whole-graph stale flag — honors cases where
  // stale_files is empty (whole-graph invalidations). codex round 3 P2.
  stale: boolean,
  stale_files: string[],
): ReviewContextResult => {
  const index = buildGraphIndex(graph);
  const changed_files = input.files.filter((file) => index.nodesById.has(`file:${file}`)).sort();
  if (changed_files.length === 0) return { ok: false, reason: "target-not-found" };

  const exports_touched = graph.nodes.filter(
    (node) => node.kind === "exported-symbol" && node.file && changed_files.includes(node.file),
  ).length;

  const fanout_summary = changed_files.map((file) => {
    const fileId = `file:${file}`;
    const imports = (index.outgoing.get(fileId) ?? []).filter((edge) => edge.kind === "imports").length;
    const imported_by = (index.incoming.get(fileId) ?? []).filter((edge) => edge.kind === "imports").length;
    return { file, imported_by, imports };
  });

  const hotspots = [...index.byFile.entries()]
    .map(([file, nodes]) => {
      const fileId = `file:${file}`;
      const imported_by = (index.incoming.get(fileId) ?? []).filter((edge) => edge.kind === "imports").length;
      const calls_in = nodes.reduce(
        (sum, node) => sum + (index.incoming.get(node.id) ?? []).filter((edge) => edge.kind === "calls").length,
        0,
      );
      const score = imported_by + calls_in;
      return {
        file,
        score,
        reason: `imports in: ${imported_by}, calls in: ${calls_in}`,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  // 0.1.9+: scoped staleness. Reachable surface = changed files + their
  // direct importers (fanout) + hotspot files we surface. Reviewer
  // queries inherently care about every file in `input.files`, so all
  // input files count as in-scope even when not present in the graph
  // (rare: brand-new file added in the diff before a rebuild).
  //
  // codex round 8 P3: cap hotspots in the reachable set to the same
  // top-5 surfaced in the response. Including the long tail of
  // unsurfaced hotspots would credit edits to files the caller
  // never sees, inflating `stale_in_scope` and the scoped-stale
  // ratio counters in `tokenomy report`.
  const surfacedHotspots = hotspots.slice(0, 5);
  const reachable = new Set<string>([...input.files, ...changed_files]);
  for (const h of surfacedHotspots) reachable.add(h.file);
  for (const file of changed_files) {
    const fileId = `file:${file}`;
    for (const e of index.incoming.get(fileId) ?? []) {
      if (e.kind !== "imports") continue;
      const src = index.nodesById.get(e.from);
      if (src?.file) reachable.add(src.file);
    }
  }
  const scoped = scopeStale(stale, stale_files, reachable);

  return clipResultToBudget(
    {
      ok: true,
      stale: scoped.stale,
      stale_files,
      stale_in_scope: scoped.stale_in_scope,
      ...(scoped.whole_graph_stale ? { whole_graph_stale: true } : {}),
      data: {
        changed_files,
        exports_touched,
        fanout_summary: limitByCount(fanout_summary, changed_files.length),
        hotspots: surfacedHotspots,
      },
    },
    cfg.graph.query_budget_bytes.get_review_context,
  );
};
