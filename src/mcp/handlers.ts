import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import type { Config, GraphQueryBudgetConfig, OssSearchEcosystem } from "../core/types.js";
import { buildGraph } from "../graph/build.js";
import type { GraphQueryContext, LoadGraphContextOptions } from "../graph/query/common.js";
import { loadGraphContext } from "../graph/query/common.js";
import { impactRadius } from "../graph/query/impact.js";
import { minimalContext } from "../graph/query/minimal.js";
import { reviewContext } from "../graph/query/review.js";
import { findUsages } from "../graph/query/usages.js";
import { isGraphStaleCheap } from "../graph/stale.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { npmSearch, registrySearch } from "../nudge/npm-search.js";
import { repoSearch } from "../nudge/repo-search.js";
import { createAndSaveRavenPacket } from "../raven/brief.js";
import { compareReviews } from "../raven/compare.js";
import { collectGitState } from "../raven/git.js";
import { getPrReadiness } from "../raven/pr-check.js";
import { recordDecision, recordReview } from "../raven/review.js";
import type { RavenAgent, RavenDecisionValue, RavenFinding, RavenVerdict } from "../raven/schema.js";
import { listReviews, readPacket, ravenStoreForRepo } from "../raven/store.js";
import type {
  BuildGraphResult,
  FailOpen,
  FindUsagesInput,
  ImpactRadiusInput,
  MinimalContextInput,
  QueryResult,
  ReviewContextInput,
} from "../graph/types.js";
import { clipToolResultToBudget } from "./budget-clip.js";
import { QueryCache } from "./query-cache.js";

// Process-scoped cache. Shared across all tool dispatches within one MCP
// server lifetime. Invalidates whenever the underlying graph is rebuilt
// (meta.built_at forms part of the cache key).
const queryCache = new QueryCache();

// Read-only tools we cache. `build_or_update_graph` is a write and must
// invalidate the cache rather than read from it.
const CACHEABLE_TOOLS = new Set([
  "get_minimal_context",
  "get_impact_radius",
  "get_review_context",
  "find_usages",
]);

const RAVEN_TOOLS = new Set([
  "create_handoff_packet",
  "read_handoff_packet",
  "record_agent_review",
  "list_agent_reviews",
  "compare_agent_reviews",
  "get_pr_readiness",
  "record_decision",
]);

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

const parseFindUsagesInput = (args: Record<string, unknown>): FindUsagesInput | null => {
  const target = asObject(args["target"]);
  if (typeof target["file"] !== "string" || target["file"].length === 0) return null;
  return {
    target: {
      file: target["file"],
      ...(typeof target["symbol"] === "string" ? { symbol: target["symbol"] } : {}),
    },
  };
};

const parseReviewContextInput = (args: Record<string, unknown>): ReviewContextInput | null => {
  const files = Array.isArray(args["files"])
    ? args["files"].filter((file): file is string => typeof file === "string" && file.length > 0)
    : [];
  return files.length > 0 ? { files } : null;
};

interface FindAlternativesInput {
  description: string;
  keywords?: string[];
  min_weekly_downloads?: number;
  max_results?: number;
  ecosystems?: OssSearchEcosystem[];
}

const parseFindAlternativesInput = (
  args: Record<string, unknown>,
): FindAlternativesInput | null => {
  const description = args["description"];
  if (typeof description !== "string" || description.trim().length === 0) return null;
  const keywords = Array.isArray(args["keywords"])
    ? args["keywords"].filter((k): k is string => typeof k === "string" && k.length > 0)
    : undefined;
  const min =
    typeof args["min_weekly_downloads"] === "number" && args["min_weekly_downloads"] >= 0
      ? args["min_weekly_downloads"]
      : undefined;
  const max =
    typeof args["max_results"] === "number" && args["max_results"] > 0
      ? args["max_results"]
      : undefined;
  const allowed = new Set(["npm", "pypi", "go", "maven"]);
  const ecosystems = Array.isArray(args["ecosystems"])
    ? args["ecosystems"].filter(
        (value): value is OssSearchEcosystem =>
          typeof value === "string" && allowed.has(value),
      )
    : undefined;
  return {
    description: description.trim(),
    ...(keywords && keywords.length > 0 ? { keywords } : {}),
    ...(min !== undefined ? { min_weekly_downloads: min } : {}),
    ...(max !== undefined ? { max_results: max } : {}),
    ...(ecosystems && ecosystems.length > 0 ? { ecosystems } : {}),
  };
};

const inferProjectEcosystems = (cwd: string): OssSearchEcosystem[] => {
  const out: OssSearchEcosystem[] = [];
  const has = (file: string): boolean => existsSync(join(cwd, file));
  if (has("package.json") || has("pnpm-lock.yaml") || has("yarn.lock")) out.push("npm");
  if (
    has("pyproject.toml") ||
    has("setup.py") ||
    has("setup.cfg") ||
    has("requirements.txt")
  ) {
    out.push("pypi");
  }
  if (has("go.mod")) out.push("go");
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) out.push("maven");
  return out;
};

const resolveOssEcosystems = (
  input: FindAlternativesInput,
  cwd: string,
  config: Config,
): OssSearchEcosystem[] => {
  if (input.ecosystems && input.ecosystems.length > 0) return input.ecosystems;
  const inferred = inferProjectEcosystems(cwd);
  if (inferred.length > 0) return inferred;
  return config.nudge?.oss_search.ecosystems ?? ["npm"];
};

interface PrecomputedStale {
  stale: boolean;
  stale_files: string[];
}

const withGraphContext = <T>(
  cwd: string,
  run: (config: Config, graphContext: GraphQueryContext) => QueryResult<T>,
  precomputedStale?: PrecomputedStale,
): QueryResult<T> => {
  const config = loadConfig(cwd);
  const loadOptions: LoadGraphContextOptions = precomputedStale
    ? { skipStaleCheck: true, precomputedStale }
    : {};
  const graphContext = loadGraphContext(cwd, config, loadOptions);
  if (!graphContext.ok) return graphContext;
  return run(config, graphContext.data);
};

// Read-side auto-refresh helper. Called before every cacheable graph tool
// ONLY when cfg.graph.auto_refresh_on_read is true — the opt-out path in
// dispatchGraphTool skips this helper entirely and lets loadGraphContext
// run the regular SHA-based stale check instead (preserving pre-alpha.15
// behavior exactly).
//
// Uses isGraphStaleCheap (meta-only, mtime-only) to short-circuit when the
// graph is fresh; invokes buildGraph({force:false}) when stale; trusts
// buildGraph's authoritative result over the cheap precheck when it returns
// ok.
//
// Returns a FailOpen when the rebuild itself fails (repo-too-large, timeout,
// build-in-progress, io-error, etc.) — this is propagated up to the MCP
// caller so they see the actionable reason instead of silently receiving
// a stale snapshot. Catches unexpected throws and falls back to the cheap
// pre-check's stale state so the read path doesn't tear down.
// 0.1.3+: in-flight rebuild lockset. Keyed on repoId. Prevents the agent
// from kicking off N parallel rebuilds in quick succession when each tool
// call sees a stale snapshot. Process-local; the on-disk
// graphRebuildLockPath sentinel covers cross-process concurrency.
const inFlightRebuilds = new Set<string>();

const startBackgroundRebuild = (cwd: string, cfg: Config): void => {
  let repoId: string;
  try {
    repoId = resolveRepoId(cwd).repoId;
  } catch {
    repoId = cwd;
  }
  if (inFlightRebuilds.has(repoId)) return;
  inFlightRebuilds.add(repoId);
  // Fire-and-forget. Errors are logged via buildGraph's own log path.
  void buildGraph({ cwd, config: cfg, force: false })
    .then((result) => {
      if (result.ok && result.data.built) queryCache.invalidate();
    })
    .catch(() => {
      // buildGraph is meant to be non-throwing; swallow anyway.
    })
    .finally(() => {
      inFlightRebuilds.delete(repoId);
    });
};

const ensureFreshGraph = async (
  cwd: string,
  cfg: Config,
): Promise<PrecomputedStale | FailOpen> => {
  const check = isGraphStaleCheap(cwd, cfg);
  if (!check.missing && !check.stale) return { stale: false, stale_files: [] };
  // 0.1.3+: when the snapshot exists but is stale, return the cached
  // version IMMEDIATELY and rebuild in the background. Earlier behavior
  // awaited the rebuild — on a 5k-file repo that's a 1-3s tax on every
  // first MCP query of a session, which agents respond to by skipping
  // the graph and falling back to broad Reads (defeating the point of
  // the graph). Caller still gets `stale: true` so the response can
  // surface the freshness state to the assistant.
  //
  // Path taken only when a snapshot already exists. When `missing` is
  // true (graph never built) we still await the synchronous build —
  // there's nothing to serve in the meantime.
  if (!check.missing && check.stale) {
    if (cfg.graph.async_rebuild !== false) {
      startBackgroundRebuild(cwd, cfg);
      return { stale: true, stale_files: check.stale_files };
    }
  }
  try {
    const result = await buildGraph({ cwd, config: cfg, force: false });
    if (result.ok) {
      if (result.data.built) queryCache.invalidate();
      return {
        stale: result.stale ?? false,
        stale_files: result.stale_files ?? [],
      };
    }
    // Rebuild failed with an actionable reason. Don't silently serve the
    // old snapshot — propagate the FailOpen so the caller sees e.g.
    // repo-too-large or timeout and can correct their setup.
    return result;
  } catch {
    // Unexpected throw (buildGraph is meant to be non-throwing) — fail-open
    // to the cheap pre-check view so the read path still produces a result.
    return { stale: check.stale, stale_files: check.stale_files };
  }
};

// Lightweight arg validation for the four cacheable read-side tools. Runs
// BEFORE ensureFreshGraph so a malformed call (e.g. `{}` to get_minimal_context)
// returns `invalid-input` directly rather than silently triggering a graph
// rebuild that might surface a misleading reason like `repo-too-large`.
const earlyValidateReadArgs = (
  name: string,
  args: Record<string, unknown>,
): QueryResult<unknown> | null => {
  if (name === "get_minimal_context") {
    if (!parseMinimalContextInput(args))
      return fail("invalid-input", "Expected { target: { file, symbol? }, depth? }.");
  } else if (name === "get_impact_radius") {
    if (!parseImpactRadiusInput(args))
      return fail("invalid-input", "Expected { changed: [{ file, symbols? }], max_depth? }.");
  } else if (name === "find_usages") {
    if (!parseFindUsagesInput(args))
      return fail("invalid-input", "Expected { target: { file, symbol? } }.");
  } else if (name === "get_review_context") {
    if (!parseReviewContextInput(args))
      return fail("invalid-input", "Expected { files: string[] }.");
  } else if (name === "find_oss_alternatives") {
    if (!parseFindAlternativesInput(args))
      return fail(
        "invalid-input",
        "Expected { description: string, keywords?, min_weekly_downloads?, max_results?, ecosystems? }.",
      );
  }
  return null;
};

export const _resetQueryCacheForTests = (): void => queryCache.invalidate();
export const _queryCacheSize = (): number => queryCache.size;

// Cache-version helper: the LRU is keyed on (tool, args, version). We mix
// the per-tool budget into `version` so a `tokenomy config set
// graph.query_budget_bytes.<tool> <N>` invalidates prior (clipped) responses
// for that tool without requiring a graph rebuild. Other tools' caches are
// unaffected because only their own budget is part of their version string.
const cacheVersion = (tool: string, builtAt: string, cfg: Config): string => {
  const budget = cfg.graph.query_budget_bytes[tool as keyof GraphQueryBudgetConfig];
  return `${builtAt}#b=${budget ?? 0}`;
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
  // 0.1.3+: every tool accepts an optional `path` arg so callers can route
  // the query at a specific repo. Falls back to the MCP server's startup
  // cwd. Resolves the cross-repo bleed where a single MCP instance bound
  // to one cwd was returning data for the wrong repo when the agent
  // worked across multiple repos in one session.
  const argPath = typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : null;
  const effectiveCwd = argPath ?? cwd;

  if (RAVEN_TOOLS.has(name)) {
    return dispatchRavenTool(name, args, effectiveCwd);
  }

  if (name === "build_or_update_graph") {
    const config = loadConfig(effectiveCwd);
    if (!config.graph.enabled) return fail("graph-disabled");
    const result: BuildGraphResult = await buildGraph({
      cwd: effectiveCwd,
      force: args["force"] === true,
      config,
    });
    // A successful rebuild invalidates all cached queries.
    if (result.ok && result.data.built) queryCache.invalidate();
    return withBudget(result, config.graph.query_budget_bytes.build_or_update_graph);
  }

  // Read-path cache lookup: key on graph version (meta.built_at) so a rebuild
  // transparently invalidates entries even across handler calls that skip the
  // build_or_update_graph path.
  const cacheable = CACHEABLE_TOOLS.has(name);
  let cacheKey: string | null = null;
  let precomputedStale: PrecomputedStale | undefined;

  if (cacheable) {
    // Validate tool-specific arguments BEFORE touching the graph. A malformed
    // read call must not trigger a rebuild — users deserve the actionable
    // `invalid-input` hint rather than a rebuild-failure reason.
    const invalid = earlyValidateReadArgs(name, args);
    if (invalid) return invalid;

    const config = loadConfig(effectiveCwd);

    // Auto-refresh is opt-in via config. When enabled, run the cheap stale
    // check + conditional rebuild FIRST; when disabled, skip entirely and let
    // loadGraphContext do its normal SHA-based stale check (pre-alpha.15
    // behavior — mtime-only stale isn't good enough for the opt-out path
    // because a `touch` would incorrectly flag a file as changed).
    if (config.graph.auto_refresh_on_read) {
      const fresh = await ensureFreshGraph(effectiveCwd, config);
      if ("ok" in fresh && fresh.ok === false) {
        // Rebuild failed with an actionable reason — surface it to the caller
        // instead of serving a silently-stale snapshot.
        return fresh;
      }
      precomputedStale = fresh as PrecomputedStale;
    }

    let graphContext = loadGraphContext(
      effectiveCwd,
      config,
      precomputedStale ? { skipStaleCheck: true, precomputedStale } : {},
    );
    // Recovery path: isGraphStaleCheap only does existsSync on the snapshot
    // file, so a corrupt/unparsable snapshot (meta intact) slips through as
    // "fresh". The full load here is the first place we actually parse the
    // snapshot — if that fails with graph-not-built while auto-refresh is on,
    // force a rebuild and retry once.
    if (
      !graphContext.ok &&
      graphContext.reason === "graph-not-built" &&
      config.graph.auto_refresh_on_read
    ) {
      try {
        const rebuild = await buildGraph({ cwd: effectiveCwd, config, force: false });
        if (!rebuild.ok) return rebuild;
        queryCache.invalidate();
        precomputedStale = {
          stale: rebuild.stale ?? false,
          stale_files: rebuild.stale_files ?? [],
        };
        graphContext = loadGraphContext(effectiveCwd, config, {
          skipStaleCheck: true,
          precomputedStale,
        });
      } catch {
        // Fail-open to the original graph-not-built so the caller at least
        // sees an actionable reason rather than a thrown exception.
      }
    }
    if (graphContext.ok) {
      // Cache version binds the graph snapshot (`built_at`) AND the
      // per-tool response budget. Without the budget binding, a
      // `tokenomy config set graph.query_budget_bytes.<tool> <N>` is a
      // silent no-op until the next rebuild: cached clipped responses
      // keep returning the old (smaller) result.
      const version = cacheVersion(name, graphContext.data.meta.built_at, config);
      cacheKey = queryCache.key(name, args, version);
      const cached = queryCache.get(cacheKey);
      if (cached !== undefined) return cached as QueryResult<unknown>;
    }
  }

  const result = await dispatchGraphToolUncached(name, args, effectiveCwd, precomputedStale);
  if (cacheKey && result.ok) queryCache.set(cacheKey, result);
  return result;
};

const dispatchGraphToolUncached = async (
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  precomputedStale?: PrecomputedStale,
): Promise<QueryResult<unknown>> => {

  if (name === "get_minimal_context") {
    const input = parseMinimalContextInput(args);
    if (!input) return fail("invalid-input", "Expected { target: { file, symbol? }, depth? }.");
    return withGraphContext(
      cwd,
      (config, graphContext) =>
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
      precomputedStale,
    );
  }

  if (name === "get_impact_radius") {
    const input = parseImpactRadiusInput(args);
    if (!input) return fail("invalid-input", "Expected { changed: [{ file, symbols? }], max_depth? }.");
    return withGraphContext(
      cwd,
      (config, graphContext) =>
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
      precomputedStale,
    );
  }

  if (name === "find_usages") {
    const input = parseFindUsagesInput(args);
    if (!input) return fail("invalid-input", "Expected { target: { file, symbol? } }.");
    return withGraphContext(
      cwd,
      (config, graphContext) =>
        withBudget(
          findUsages(
            graphContext.graph,
            input,
            config,
            graphContext.stale,
            graphContext.stale_files,
          ),
          config.graph.query_budget_bytes.find_usages,
        ),
      precomputedStale,
    );
  }

  if (name === "get_review_context") {
    const input = parseReviewContextInput(args);
    if (!input) return fail("invalid-input", "Expected { files: string[] }.");
    return withGraphContext(
      cwd,
      (config, graphContext) =>
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
      precomputedStale,
    );
  }

  if (name === "find_oss_alternatives") {
    const input = parseFindAlternativesInput(args);
    if (!input) {
      return fail(
        "invalid-input",
        "Expected { description: string, keywords?, min_weekly_downloads?, max_results?, ecosystems? }.",
      );
    }
    const config = loadConfig(cwd);
    const nudge = config.nudge;
    const timeoutMs = nudge?.oss_search.timeout_ms ?? 5_000;
    const minDownloads = input.min_weekly_downloads ?? nudge?.oss_search.min_weekly_downloads ?? 1_000;
    const maxResults = input.max_results ?? nudge?.oss_search.max_results ?? 5;
    const ecosystems = resolveOssEcosystems(input, cwd, config);
    const query =
      input.keywords && input.keywords.length > 0
        ? `${input.description} ${input.keywords.join(" ")}`
        : input.description;
    const repo = repoSearch(cwd, query, { timeoutMs, maxResults });
    const repoResults = repo.ok ? repo.results : [];
    const searchOptions = {
      timeoutMs,
      minWeeklyDownloads: minDownloads,
      maxResults,
    };
    const searches = await Promise.all(
      ecosystems.map((ecosystem) =>
        ecosystem === "npm"
          ? npmSearch(query, searchOptions)
          : registrySearch(ecosystem, query, searchOptions),
      ),
    );
    const hardFailure = searches.find((search) => !search.ok);
    const results = searches.flatMap((search) => (search.ok ? search.results : []));
    if (results.length === 0 && repoResults.length === 0 && hardFailure && !hardFailure.ok) {
      return withBudget(hardFailure, config.graph.query_budget_bytes.find_oss_alternatives);
    }
    const top = results[0];
    const summaryParts: string[] = [];
    if (repoResults.length > 0) {
      summaryParts.push(
        `Found ${repoResults.length} repo match${repoResults.length === 1 ? "" : "es"} ` +
          `on the current or another branch.`,
      );
    }
    if (results.length > 0) {
      summaryParts.push(
        `Found ${results.length} package candidate${results.length === 1 ? "" : "s"} ` +
          `across ${ecosystems.join(", ")}. ` +
          `Top pick: ${top ? top.name : "(none)"}${top ? ` (${top.fit_reason})` : ""}.`,
      );
    }
    const summary =
      summaryParts.length === 0
        ? "No repo matches or maintained package candidates found above quality threshold."
        : summaryParts.join(" ");
    const hint =
      repoResults.length > 0
        ? "Review repo matches first to avoid rebuilding existing work; then compare package candidates before implementing."
        : results.length === 0
          ? "No match — it's reasonable to proceed with a from-scratch implementation."
          : "Present these package candidates to the user; let them pick. If none fit, proceed to implement.";
    return withBudget(
      {
        ok: true,
        data: {
          query,
          ecosystems,
          repo_results: repoResults,
          results,
          summary,
          hint,
        },
      } as QueryResult<unknown>,
      config.graph.query_budget_bytes.find_oss_alternatives,
    );
  }

  return fail("unsupported-tool");
};

const parseStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];

const parseRavenAgent = (value: unknown): RavenAgent | undefined =>
  value === "claude-code" || value === "codex" || value === "human" ? value : undefined;

const parseRavenVerdict = (value: unknown): RavenVerdict | undefined =>
  value === "pass" || value === "needs-work" || value === "risky" || value === "blocked" ? value : undefined;

const parseRavenDecision = (value: unknown): RavenDecisionValue | undefined =>
  value === "merge" || value === "fix-first" || value === "investigate" || value === "defer" || value === "abandon"
    ? value
    : undefined;

const parseRavenIntent = (value: unknown): "review" | "handoff" | "pr-check" | "second-opinion" | undefined =>
  value === "review" || value === "handoff" || value === "pr-check" || value === "second-opinion" ? value : undefined;

const parseFindings = (value: unknown): RavenFinding[] =>
  Array.isArray(value)
    ? value
        .map((raw) => asObject(raw))
        .filter((f) => typeof f["title"] === "string" && typeof f["detail"] === "string")
        .map((f) => ({
          severity:
            f["severity"] === "critical" || f["severity"] === "high" || f["severity"] === "medium" || f["severity"] === "low"
              ? f["severity"]
              : "medium",
          ...(typeof f["file"] === "string" ? { file: f["file"] } : {}),
          ...(typeof f["line"] === "number" ? { line: f["line"] } : {}),
          title: f["title"] as string,
          detail: f["detail"] as string,
          ...(typeof f["suggested_fix"] === "string" ? { suggested_fix: f["suggested_fix"] as string } : {}),
          ...(typeof f["resolved"] === "boolean" ? { resolved: f["resolved"] as boolean } : {}),
        }))
    : [];

const ravenContext = (cwd: string): QueryResult<{ root: string; store: ReturnType<typeof ravenStoreForRepo>; cfg: Config }> => {
  const git = collectGitState(cwd);
  if (!git.ok) return git;
  const cfg = loadConfig(git.data.root);
  if (!cfg.raven.enabled) return fail("raven-disabled", "Run `tokenomy raven enable` first.");
  return { ok: true, data: { root: git.data.root, store: ravenStoreForRepo(git.data.repo_id), cfg } };
};

const ravenBudget = (cfg: Config, name: string): number =>
  cfg.graph.query_budget_bytes[name as keyof GraphQueryBudgetConfig] ?? 8_000;

const dispatchRavenTool = async (
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<QueryResult<unknown>> => {
  if (name === "create_handoff_packet") {
    const result = createAndSaveRavenPacket({
      cwd,
      goal: typeof args["goal"] === "string" ? args["goal"] : undefined,
      targetAgent: parseRavenAgent(args["target_agent"]),
      intent: parseRavenIntent(args["intent"]) ?? "review",
      sourceAgent: "claude-code",
    });
    const cfg = loadConfig(cwd);
    return withBudget(result.ok ? { ok: true, data: result.data } : result, ravenBudget(cfg, name));
  }

  const ctx = ravenContext(cwd);
  if (!ctx.ok) return ctx;
  const packetId = typeof args["packet_id"] === "string" ? args["packet_id"] : undefined;
  const packet = readPacket(ctx.data.store, packetId);
  if (!packet) return fail("packet-not-found", "Run `create_handoff_packet` first.");

  if (name === "read_handoff_packet") {
    return withBudget({ ok: true, data: packet }, ravenBudget(ctx.data.cfg, name));
  }
  if (name === "record_agent_review") {
    const agent = parseRavenAgent(args["agent"]);
    const verdict = parseRavenVerdict(args["verdict"]);
    if (!agent || !verdict) return fail("invalid-input", "Expected { agent, verdict, findings?, questions?, suggested_tests? }.");
    const review = recordReview({
      packet,
      cwd: ctx.data.root,
      store: ctx.data.store,
      agent,
      verdict,
      findings: parseFindings(args["findings"]),
      questions: parseStringArray(args["questions"]),
      suggested_tests: parseStringArray(args["suggested_tests"]),
    });
    return withBudget(review.ok ? { ok: true, data: review.data } : review, ravenBudget(ctx.data.cfg, name));
  }
  if (name === "list_agent_reviews") {
    return withBudget({ ok: true, data: listReviews(ctx.data.store, packet.packet_id) }, ravenBudget(ctx.data.cfg, name));
  }
  if (name === "compare_agent_reviews") {
    const result = compareReviews(packet, ctx.data.root, ctx.data.store, listReviews(ctx.data.store, packet.packet_id));
    return withBudget(result.ok ? { ok: true, data: result.data } : result, ravenBudget(ctx.data.cfg, name));
  }
  if (name === "get_pr_readiness") {
    const result = getPrReadiness(packet, ctx.data.root, ctx.data.store, listReviews(ctx.data.store, packet.packet_id));
    return withBudget(result.ok ? { ok: true, data: result.data } : result, ravenBudget(ctx.data.cfg, name));
  }
  if (name === "record_decision") {
    const decision = parseRavenDecision(args["decision"]);
    const rationale = typeof args["rationale"] === "string" ? args["rationale"] : undefined;
    const decidedBy = parseRavenAgent(args["decided_by"]);
    if (!decision || !rationale || !decidedBy) return fail("invalid-input", "Expected { decision, rationale, decided_by, review_ids? }.");
    const result = recordDecision({
      packet,
      cwd: ctx.data.root,
      store: ctx.data.store,
      decision,
      rationale,
      decided_by: decidedBy,
      review_ids: parseStringArray(args["review_ids"]),
    });
    return withBudget(result.ok ? { ok: true, data: result.data } : result, ravenBudget(ctx.data.cfg, name));
  }

  return fail("unsupported-tool");
};
