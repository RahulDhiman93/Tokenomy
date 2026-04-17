import type { Config } from "../../core/types.js";
import type { Graph } from "../schema.js";
import type { ReviewContextInput, ReviewContextResult } from "../types.js";
import { buildGraphIndex } from "./common.js";
import { clipResultToBudget, limitByCount } from "./budget.js";

export const reviewContext = (
  graph: Graph,
  input: ReviewContextInput,
  cfg: Config,
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

  return clipResultToBudget(
    {
      ok: true,
      stale,
      stale_files,
      data: {
        changed_files,
        exports_touched,
        fanout_summary: limitByCount(fanout_summary, changed_files.length),
        hotspots: limitByCount(hotspots, 5),
      },
    },
    cfg.graph.query_budget_bytes.get_review_context,
  );
};
