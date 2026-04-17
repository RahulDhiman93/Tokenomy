import { existsSync, readFileSync } from "node:fs";
import { graphMetaPath, graphSnapshotPath } from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { safeParse, stableStringify } from "../util/json.js";
import { GRAPH_SCHEMA_VERSION, type Graph, type GraphMeta } from "./schema.js";

export interface GraphStore {
  loadGraph(repoId: string): Graph | null;
  loadMeta(repoId: string): GraphMeta | null;
  save(repoId: string, graph: Graph, meta: GraphMeta): void;
}

const isGraph = (value: unknown): value is Graph =>
  !!value &&
  typeof value === "object" &&
  (value as { schema_version?: unknown }).schema_version === GRAPH_SCHEMA_VERSION &&
  Array.isArray((value as { nodes?: unknown }).nodes) &&
  Array.isArray((value as { edges?: unknown }).edges) &&
  Array.isArray((value as { parse_errors?: unknown }).parse_errors);

const isGraphMeta = (value: unknown): value is GraphMeta =>
  !!value &&
  typeof value === "object" &&
  (value as { schema_version?: unknown }).schema_version === GRAPH_SCHEMA_VERSION &&
  typeof (value as { repo_id?: unknown }).repo_id === "string" &&
  typeof (value as { repo_path?: unknown }).repo_path === "string" &&
  typeof (value as { built_at?: unknown }).built_at === "string";

export class JsonGraphStore implements GraphStore {
  loadGraph(repoId: string): Graph | null {
    const path = graphSnapshotPath(repoId);
    if (!existsSync(path)) return null;
    const parsed = safeParse<unknown>(readFileSync(path, "utf8"));
    return isGraph(parsed) ? parsed : null;
  }

  loadMeta(repoId: string): GraphMeta | null {
    const path = graphMetaPath(repoId);
    if (!existsSync(path)) return null;
    const parsed = safeParse<unknown>(readFileSync(path, "utf8"));
    return isGraphMeta(parsed) ? parsed : null;
  }

  save(repoId: string, graph: Graph, meta: GraphMeta): void {
    atomicWrite(graphSnapshotPath(repoId), `${stableStringify(graph)}\n`, false);
    atomicWrite(graphMetaPath(repoId), `${stableStringify(meta)}\n`, false);
  }
}
