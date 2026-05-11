import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { graphAsyncFailurePath, graphBuildLogPath } from "../core/paths.js";
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

// 0.1.8+: every known build-failure reason now has an actionable hint
// so the user sees a concrete next step in `tokenomy diagnose`,
// `tokenomy graph status`, and the MCP `last_build_failure` field.
const fallbackHint = (reason: string): string | undefined => {
  if (reason === "graph-too-large") {
    return "Snapshot exceeded graph.max_snapshot_bytes. Raise it via `tokenomy config set graph.max_snapshot_bytes 200000000` or exclude generated dirs with `tokenomy config set graph.exclude '[\"dist/**\",\"coverage/**\"]'`, then `tokenomy graph build`.";
  }
  if (reason === "repo-too-large") {
    return "Repo exceeds graph.hard_max_files. Tighten graph.exclude or raise the cap with `tokenomy config set graph.hard_max_files 50000`.";
  }
  if (reason === "typescript-not-installed") {
    return "Install `typescript` in the target repo (`npm i -D typescript`) or globally (`npm i -g typescript`), then `tokenomy graph build`.";
  }
  if (reason === "no-files") {
    return "Enumerator found 0 TS/JS files under the repo root. Check graph.exclude isn't filtering everything; remove `tests/**` etc. from exclude if you expected those.";
  }
  if (reason === "timeout") {
    return "Build exceeded graph.build_timeout_ms. Raise it via `tokenomy config set graph.build_timeout_ms 60000`, exclude large dirs, or enable `graph.incremental: true` for delta rebuilds.";
  }
  if (reason === "io-error") {
    return "Filesystem error during build. Check the repo isn't on a transient mount (NFS, network share) and that the user has read access to every TS/JS file.";
  }
  if (reason === "build-in-progress") {
    return "Another `tokenomy graph build` is in flight. Wait, or if the lock is truly stale, `rm ~/.tokenomy/graphs/<repoId>/.lock` and retry.";
  }
  if (reason === "graph-disabled") {
    return "Graph is turned off. Enable with `tokenomy config set graph.enabled true`.";
  }
  if (reason === "graph-not-built") {
    return "No snapshot yet for this repo. Run `tokenomy graph build --path \"$PWD\"`.";
  }
  if (reason === "git-resolve-failed") {
    return "`git rev-parse` could not locate the repo root. Confirm `git status` works from the cwd.";
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

// 0.1.8+: per-repo "last async rebuild failure" sentinel. Written by
// the MCP read-side `startBackgroundRebuild` whenever a fire-and-forget
// rebuild returns !ok; cleared by a successful build. The dispatcher
// embeds this in every cacheable response as `last_build_failure` so
// the agent learns about the failure instead of silently consuming an
// 11-day-old graph.

export interface AsyncBuildFailureRecord {
  ts: string;
  reason: string;
  hint?: string;
}

export const writeAsyncBuildFailure = (
  repoId: string,
  record: AsyncBuildFailureRecord,
): void => {
  try {
    const path = graphAsyncFailurePath(repoId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record));
  } catch {
    // diagnostic only; never break the rebuild path
  }
};

export const clearAsyncBuildFailure = (repoId: string): void => {
  try {
    const path = graphAsyncFailurePath(repoId);
    if (existsSync(path)) rmSync(path, { force: true });
  } catch {
    // diagnostic only
  }
};

export const readAsyncBuildFailure = (
  repoId: string,
): AsyncBuildFailureRecord | null => {
  const path = graphAsyncFailurePath(repoId);
  if (!existsSync(path)) return null;
  try {
    const parsed = safeParse<AsyncBuildFailureRecord>(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed.reason !== "string" || typeof parsed.ts !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};
