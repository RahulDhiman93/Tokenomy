import { existsSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import type { Config } from "../core/types.js";
import { matchesAnyGlob } from "../util/glob.js";

// OSS-alternatives-first nudge for the Write tool. When Claude is about to
// create a NEW file at a "utility-ish" path (src/utils/**, src/lib/**, etc.)
// whose content crosses a size threshold, we append additionalContext to the
// tool result reminding the agent to call `find_oss_alternatives` first. The
// tool checks the current repo/branches as well as package registries.
//
// Conservative by design:
// - Only new files (existsSync returns false). Overwrites are treated as
//   existing-code edits, not fresh reinvention.
// - Size threshold filters out tiny stubs, types-only modules, re-export
//   barrels, and index.ts hubs that aren't being "implemented".
// - Configurable glob list so users can add/remove trigger directories.
// - Never modifies tool_input — we never want to block or mutate the Write.
//
// Channel: uses `additionalContext` (same mechanism as the Read clamp and
// Bash bounder). Claude Code surfaces this to the model as an annotation on
// the tool result.

export interface WriteNudgeResult {
  kind: "nudge" | "passthrough";
  /** The unaltered tool_input — we never mutate Write calls. */
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

const toPosix = (p: string): string => p.split("\\").join("/");

const relPosix = (cwd: string, absPath: string): string => {
  const rel = relative(cwd, absPath);
  return toPosix(rel);
};

const formatKB = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  return `${Math.round(kb)} KB`;
};

const buildHint = (relFilePath: string, sizeBytes: number): string =>
  `[tokenomy-nudge: you're creating a new file at \`${relFilePath}\` ` +
  `(${formatKB(sizeBytes)}). Before implementing from scratch, call the ` +
  `\`mcp__tokenomy-graph__find_oss_alternatives\` MCP tool with a one-line ` +
  `description of what you're building — it checks this repo, other local ` +
  `branches, and maintained package registries so you don't rebuild existing ` +
  `work or reimplement mature utilities (HTTP clients, date math, validators, ` +
  `parsers, retry wrappers, rate limiters, caches, schema validators, etc.). ` +
  `That can save 10-50k tokens per avoided rewrite. If you've already evaluated ` +
  `repo matches and external alternatives, or this is project-specific glue ` +
  `code, proceed. Disable these nudges: ` +
  `\`tokenomy config set nudge.write_intercept.enabled false\`.]`;

export const writeNudgeRule = (
  toolInput: Record<string, unknown>,
  cfg: Config,
  cwd: string,
): WriteNudgeResult => {
  const nudge = cfg.nudge;
  if (!nudge || !nudge.enabled) return { kind: "passthrough" };
  if (!nudge.write_intercept.enabled) return { kind: "passthrough" };

  const rawPath = toolInput["file_path"];
  const content = toolInput["content"];
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    return { kind: "passthrough" };
  }
  if (typeof content !== "string") return { kind: "passthrough" };

  const absPath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);

  // Only fire on new files. Overwriting an existing file is rarely "I'm
  // reinventing a library" — it's usually iteration on existing code.
  if (existsSync(absPath)) return { kind: "passthrough" };

  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes < nudge.write_intercept.min_size_bytes) {
    return { kind: "passthrough" };
  }

  const rel = posix.normalize(relPosix(cwd, absPath));
  // Path must not escape the repo (`../../foo`) and must match a configured
  // trigger glob. Gitignore-style matcher (reused from the graph module).
  if (rel.startsWith("..") || !matchesAnyGlob(rel, nudge.write_intercept.paths)) {
    return { kind: "passthrough" };
  }

  return {
    kind: "nudge",
    updatedInput: toolInput,
    additionalContext: buildHint(rel, sizeBytes),
  };
};
