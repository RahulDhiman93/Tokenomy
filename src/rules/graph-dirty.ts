import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as pathResolve } from "node:path";
import type { Config, HookInput } from "../core/types.js";
import { graphDir, graphDirtySentinelPath } from "../core/paths.js";
import { resolveRepoId } from "../graph/repo-id.js";

// Graph-dirty sentinel for PostToolUse on Edit / Write / MultiEdit.
//
// Why: the graph snapshot is built once (`tokenomy init --graph-path`) and
// only refreshed when an MCP graph tool runs. If the agent edits N files in
// a session without calling the graph, the next graph query on stale data
// silently returns out-of-date hotspots / call sites — and on a large repo,
// `isGraphStaleCheap` walks the entire tree just to detect the drift.
//
// This rule writes a one-byte `.dirty` file under
// `~/.tokenomy/graphs/<repo-id>/.dirty` whenever Tokenomy sees an Edit /
// Write / MultiEdit complete. `isGraphStaleCheap` short-circuits to "stale"
// the moment the sentinel exists — O(1) instead of O(repo) — and the next
// MCP read-side query rebuilds.
//
// Fail-open everywhere: missing config, missing repo_id, write errors all
// silently no-op. Never blocks the tool call.

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const isEditTool = (name: string | undefined): boolean =>
  typeof name === "string" && EDIT_TOOLS.has(name);

export const markGraphDirty = (input: HookInput, cfg: Config): void => {
  if (!cfg.graph?.enabled) return;
  if (!isEditTool(input.tool_name)) return;
  if (!input.cwd || typeof input.cwd !== "string") return;
  try {
    const identity = resolveRepoId(input.cwd);
    const dir = graphDir(identity, cfg.graph);
    if (!existsSync(dir)) {
      // No graph snapshot exists for this repo yet — nothing to invalidate.
      // Don't auto-create the dir; that would imply a graph the user never
      // built and the read-side would treat it as missing → rebuild storm.
      return;
    }
    const sentinel = graphDirtySentinelPath(identity, cfg.graph);
    mkdirSync(dirname(sentinel), { recursive: true });
    // codex round 4 P2: resolve the recorded file_path to an
    // ABSOLUTE path before writing. PostToolUse `cwd` can be a
    // subdirectory of the repo (e.g. `cwd=/repo/src`,
    // `file_path='a.ts'` means `/repo/src/a.ts`). Without anchoring
    // at write time, the read-side parser couldn't distinguish a
    // repo-root-relative `a.ts` from a subdir-relative one; absolute
    // paths normalize cleanly there via `path.relative(repoPath, ...)`.
    const rawFilePath =
      typeof input.tool_input?.["file_path"] === "string"
        ? (input.tool_input["file_path"] as string)
        : "";
    const filePath = rawFilePath
      ? isAbsolute(rawFilePath)
        ? rawFilePath
        : pathResolve(input.cwd, rawFilePath)
      : "";
    writeFileSync(sentinel, `${new Date().toISOString()}\t${filePath}\n`, { flag: "a" });
  } catch {
    // best-effort; never throw out of a hook
  }
};
