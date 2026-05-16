import type { Confidence, EdgeKind, NodeKind } from "./schema.js";

export interface FailOpen {
  ok: false;
  reason: string;
  hint?: string;
}

export interface Ok<T> {
  ok: true;
  // 0.1.9+: `stale` is CONSERVATIVE — true whenever ANY uncommitted
  // disk drift exists, regardless of whether that drift can actually
  // affect this query's answer. Reason: scoping is computed from the
  // OLD snapshot's reachable surface, so a new edit can introduce
  // edges the snapshot can't show. To check whether the drift is
  // KNOWN to be relevant, read `stale_in_scope` — that's the precise
  // subset of edited files that intersect this query's reachable set.
  // `stale_in_scope.length === 0` while `stale: true` means "drift
  // exists but is most likely unrelated to this answer" — the agent
  // can proceed with the cached answer at low risk.
  stale?: boolean;
  // Whole-graph drift list: every file the cheap stale-check found
  // diverged from the snapshot. May be empty during whole-graph
  // invalidations (exclude_fingerprint / tsconfig_fingerprint).
  stale_files?: string[];
  // Scoped subset of `stale_files`: edits known to intersect this
  // query's reachable surface.
  stale_in_scope?: string[];
  // 0.1.9+ codex round 9 P2: true when the staleness is a whole-
  // graph invalidation (exclude/tsconfig/jsconfig/.tokenomy.json
  // fingerprint changed, OR `.dirty` references a config file).
  // Distinguishes "EVERY query is potentially affected" from
  // "unrelated drift" — both have `stale_in_scope: []`, so agents
  // can't use scoped-stale as a low-risk signal when this is set.
  whole_graph_stale?: boolean;
  // 0.1.9+: how long the most recent dirty signal has been pending,
  // measured at response time. Useful when the rebuild worker is
  // active and the caller wants to decide whether to wait vs.
  // proceed.
  lag_ms?: number;
  data: T;
  truncated?: { dropped_count: number };
}

export type QueryResult<T> = Ok<T> | FailOpen;

export interface BuildGraphData {
  repo_id: string;
  built: boolean;
  node_count: number;
  edge_count: number;
  parse_error_count: number;
  duration_ms: number;
  skipped_files: string[];
}

export interface GraphStatusData {
  repo_id: string;
  repo_path: string;
  built_at: string;
  file_count: number;
  node_count: number;
  edge_count: number;
  parse_error_count: number;
  skipped_files: string[];
  // 0.1.8+: present when a prior build (foreground or background async)
  // failed since the snapshot was built. The current snapshot is still
  // queryable; this just tells the user updates have been failing.
  last_build_failure?: { reason: string; hint?: string };
}

export interface MinimalContextInput {
  target: {
    file: string;
    symbol?: string;
  };
  depth?: number;
}

export interface MinimalContextNeighbor {
  id: string;
  kind: NodeKind;
  name: string;
  file?: string;
  line?: number;
  edge_kind: EdgeKind;
  direction: "in" | "out";
  confidence: Confidence;
  depth: number;
}

export interface MinimalContextData {
  focal: {
    id: string;
    kind: NodeKind;
    name: string;
    file?: string;
    line?: number;
  };
  neighbors: MinimalContextNeighbor[];
  hint: string;
}

export interface ImpactRadiusInput {
  changed: Array<{ file: string; symbols?: string[] }>;
  max_depth?: number;
}

export interface ImpactRadiusDependency {
  id: string;
  kind: NodeKind;
  name: string;
  file?: string;
  line?: number;
  depth: number;
  confidence: Confidence;
}

export interface ImpactRadiusData {
  reverse_deps: ImpactRadiusDependency[];
  suggested_tests: string[];
  summary: string;
}

export interface ReviewContextInput {
  files: string[];
}

export interface ReviewContextFanout {
  file: string;
  imported_by: number;
  imports: number;
}

export interface ReviewContextHotspot {
  file: string;
  score: number;
  reason: string;
}

export interface ReviewContextData {
  changed_files: string[];
  exports_touched: number;
  fanout_summary: ReviewContextFanout[];
  hotspots: ReviewContextHotspot[];
}

export interface FindUsagesInput {
  target: { file: string; symbol?: string };
}

export interface FindUsagesCallSite {
  id: string;
  kind: NodeKind;
  name: string;
  file?: string;
  line?: number;
  edge_kind: EdgeKind;
  confidence: Confidence;
}

export interface FindUsagesData {
  focal: { id: string; kind: NodeKind; name: string; file?: string; line?: number };
  call_sites: FindUsagesCallSite[];
  summary: string;
}

export type BuildGraphResult = QueryResult<BuildGraphData>;
export type GraphStatusResult = QueryResult<GraphStatusData>;
export type MinimalContextResult = QueryResult<MinimalContextData>;
export type ImpactRadiusResult = QueryResult<ImpactRadiusData>;
export type ReviewContextResult = QueryResult<ReviewContextData>;
export type FindUsagesResult = QueryResult<FindUsagesData>;
