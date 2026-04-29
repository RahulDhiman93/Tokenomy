import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
    const { repoId } = resolveRepoId(input.cwd);
    const dir = graphDir(repoId);
    if (!existsSync(dir)) {
      // No graph snapshot exists for this repo yet — nothing to invalidate.
      // Don't auto-create the dir; that would imply a graph the user never
      // built and the read-side would treat it as missing → rebuild storm.
      return;
    }
    const sentinel = graphDirtySentinelPath(repoId);
    mkdirSync(dirname(sentinel), { recursive: true });
    // Content carries the file_path that triggered the dirty flag so a
    // future incremental-rebuild path can scope work. For now we just
    // touch the file — `isGraphStaleCheap` only checks existence.
    const filePath =
      typeof input.tool_input?.["file_path"] === "string"
        ? (input.tool_input["file_path"] as string)
        : "";
    writeFileSync(sentinel, `${new Date().toISOString()}\t${filePath}\n`, { flag: "a" });
  } catch {
    // best-effort; never throw out of a hook
  }
};
