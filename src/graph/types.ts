import type { Confidence, EdgeKind, NodeKind } from "./schema.js";

export interface FailOpen {
  ok: false;
  reason: string;
  hint?: string;
}

export interface Ok<T> {
  ok: true;
  stale?: boolean;
  stale_files?: string[];
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

export type BuildGraphResult = QueryResult<BuildGraphData>;
export type GraphStatusResult = QueryResult<GraphStatusData>;
export type MinimalContextResult = QueryResult<MinimalContextData>;
export type ImpactRadiusResult = QueryResult<ImpactRadiusData>;
export type ReviewContextResult = QueryResult<ReviewContextData>;
