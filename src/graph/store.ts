import { existsSync, readFileSync } from "node:fs";
import {
  graphMetaPath,
  graphSnapshotPath,
  type RepoIdentityLike,
  type StorageLocationConfig,
} from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { safeParse, stableStringify } from "../util/json.js";
import { GRAPH_SCHEMA_VERSION, type Graph, type GraphMeta } from "./schema.js";

export interface GraphStore {
  loadGraph(identity: RepoIdentityLike, cfg?: StorageLocationConfig): Graph | null;
  loadMeta(identity: RepoIdentityLike, cfg?: StorageLocationConfig): GraphMeta | null;
  save(
    identity: RepoIdentityLike,
    graph: Graph,
    meta: GraphMeta,
    cfg?: StorageLocationConfig,
  ): void;
}

export const serializeGraphSnapshot = (graph: Graph): string => `${JSON.stringify(graph)}\n`;
export const serializeGraphMeta = (meta: GraphMeta): string => `${stableStringify(meta)}\n`;

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
  loadGraph(identity: RepoIdentityLike, cfg?: StorageLocationConfig): Graph | null {
    const path = graphSnapshotPath(identity, cfg);
    if (!existsSync(path)) return null;
    const parsed = safeParse<unknown>(readFileSync(path, "utf8"));
    return isGraph(parsed) ? parsed : null;
  }

  loadMeta(identity: RepoIdentityLike, cfg?: StorageLocationConfig): GraphMeta | null {
    const path = graphMetaPath(identity, cfg);
    if (!existsSync(path)) return null;
    const parsed = safeParse<unknown>(readFileSync(path, "utf8"));
    return isGraphMeta(parsed) ? parsed : null;
  }

  save(
    identity: RepoIdentityLike,
    graph: Graph,
    meta: GraphMeta,
    cfg?: StorageLocationConfig,
  ): void {
    atomicWrite(graphSnapshotPath(identity, cfg), serializeGraphSnapshot(graph), false);
    atomicWrite(graphMetaPath(identity, cfg), serializeGraphMeta(meta), false);
  }
}
