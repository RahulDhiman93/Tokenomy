import { loadConfig } from "../core/config.js";
import { buildGraph } from "../graph/build.js";
import type { GraphQueryContext } from "../graph/query/common.js";
import { loadGraphContext } from "../graph/query/common.js";
import { impactRadius } from "../graph/query/impact.js";
import { minimalContext } from "../graph/query/minimal.js";
import { reviewContext } from "../graph/query/review.js";
import type {
  BuildGraphResult,
  ImpactRadiusInput,
  MinimalContextInput,
  QueryResult,
  ReviewContextInput,
} from "../graph/types.js";
import { clipToolResultToBudget } from "./budget-clip.js";

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const fail = (reason: string, hint?: string) => ({ ok: false as const, reason, ...(hint ? { hint } : {}) });

const parseMinimalContextInput = (args: Record<string, unknown>): MinimalContextInput | null => {
  const target = asObject(args["target"]);
  if (typeof target["file"] !== "string" || target["file"].length === 0) return null;
  const depth = typeof args["depth"] === "number" ? args["depth"] : undefined;
  return {
    target: {
      file: target["file"],
      ...(typeof target["symbol"] === "string" ? { symbol: target["symbol"] } : {}),
    },
    ...(depth !== undefined ? { depth } : {}),
  };
};

const parseImpactRadiusInput = (args: Record<string, unknown>): ImpactRadiusInput | null => {
  const changed = Array.isArray(args["changed"]) ? args["changed"] : null;
  if (!changed || changed.length === 0) return null;
  const normalized = changed
    .map((entry) => {
      const value = asObject(entry);
      if (typeof value["file"] !== "string" || value["file"].length === 0) return null;
      const symbols = Array.isArray(value["symbols"])
        ? value["symbols"].filter((symbol): symbol is string => typeof symbol === "string")
        : undefined;
      return {
        file: value["file"],
        ...(symbols && symbols.length > 0 ? { symbols } : {}),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  if (normalized.length === 0) return null;
  return {
    changed: normalized,
    ...(typeof args["max_depth"] === "number" ? { max_depth: args["max_depth"] } : {}),
  };
};

const parseReviewContextInput = (args: Record<string, unknown>): ReviewContextInput | null => {
  const files = Array.isArray(args["files"])
    ? args["files"].filter((file): file is string => typeof file === "string" && file.length > 0)
    : [];
  return files.length > 0 ? { files } : null;
};

const withGraphContext = <T>(
  cwd: string,
  run: (config: ReturnType<typeof loadConfig>, graphContext: GraphQueryContext) => QueryResult<T>,
): QueryResult<T> => {
  const config = loadConfig(cwd);
  const graphContext = loadGraphContext(cwd, config);
  if (!graphContext.ok) return graphContext;
  return run(config, graphContext.data);
};

const withBudget = <T>(
  result: QueryResult<T>,
  budgetBytes: number,
): QueryResult<T> => clipToolResultToBudget(result, budgetBytes);

export const dispatchGraphTool = async (
  name: string,
  rawArgs: unknown,
  cwd: string,
): Promise<QueryResult<unknown>> => {
  const args = asObject(rawArgs);

  if (name === "build_or_update_graph") {
    const target = typeof args["path"] === "string" ? args["path"] : cwd;
    const config = loadConfig(target);
    if (!config.graph.enabled) return fail("graph-disabled");
    const result: BuildGraphResult = await buildGraph({
      cwd: target,
      force: args["force"] === true,
      config,
    });
    return withBudget(result, config.graph.query_budget_bytes.build_or_update_graph);
  }

  if (name === "get_minimal_context") {
    const input = parseMinimalContextInput(args);
    if (!input) return fail("invalid-input", "Expected { target: { file, symbol? }, depth? }.");
    return withGraphContext(cwd, (config, graphContext) =>
      withBudget(
        minimalContext(
          graphContext.graph,
          input,
          config,
          graphContext.stale,
          graphContext.stale_files,
        ),
        config.graph.query_budget_bytes.get_minimal_context,
      ),
    );
  }

  if (name === "get_impact_radius") {
    const input = parseImpactRadiusInput(args);
    if (!input) return fail("invalid-input", "Expected { changed: [{ file, symbols? }], max_depth? }.");
    return withGraphContext(cwd, (config, graphContext) =>
      withBudget(
        impactRadius(
          graphContext.graph,
          input,
          config,
          graphContext.stale,
          graphContext.stale_files,
        ),
        config.graph.query_budget_bytes.get_impact_radius,
      ),
    );
  }

  if (name === "get_review_context") {
    const input = parseReviewContextInput(args);
    if (!input) return fail("invalid-input", "Expected { files: string[] }.");
    return withGraphContext(cwd, (config, graphContext) =>
      withBudget(
        reviewContext(
          graphContext.graph,
          input,
          config,
          graphContext.stale,
          graphContext.stale_files,
        ),
        config.graph.query_budget_bytes.get_review_context,
      ),
    );
  }

  return fail("unsupported-tool");
};
