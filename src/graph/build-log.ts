import { existsSync, readFileSync } from "node:fs";
import { graphBuildLogPath } from "../core/paths.js";
import { safeParse } from "../util/json.js";
import type { GraphBuildLogEntry } from "./schema.js";
import type { FailOpen } from "./types.js";

const isGraphBuildLogEntry = (value: unknown): value is GraphBuildLogEntry =>
  !!value &&
  typeof value === "object" &&
  typeof (value as { ts?: unknown }).ts === "string" &&
  typeof (value as { repo_id?: unknown }).repo_id === "string" &&
  typeof (value as { repo_path?: unknown }).repo_path === "string" &&
  typeof (value as { built?: unknown }).built === "boolean";

export const readLastGraphBuildLog = (repoId: string): GraphBuildLogEntry | null => {
  const path = graphBuildLogPath(repoId);
  if (!existsSync(path)) return null;
  try {
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const parsed = safeParse<unknown>(line);
      if (isGraphBuildLogEntry(parsed)) return parsed;
    }
  } catch {
    // Build-log lookup is diagnostic only.
  }
  return null;
};

const fallbackHint = (reason: string): string | undefined => {
  if (reason === "graph-too-large") {
    return "Last graph build exceeded graph.max_snapshot_bytes; raise graph.max_snapshot_bytes or exclude generated/large files, then run `tokenomy graph build`.";
  }
  if (reason === "typescript-not-installed") {
    return "Install `typescript` in the target repo or alongside Tokenomy, then re-run `tokenomy graph build`.";
  }
  return undefined;
};

export const readLastGraphBuildFailure = (repoId: string): FailOpen | null => {
  const last = readLastGraphBuildLog(repoId);
  if (!last || last.built || !last.reason) return null;
  const hint = last.hint ?? fallbackHint(last.reason);
  return {
    ok: false,
    reason: last.reason,
    ...(hint ? { hint } : {}),
  };
};
