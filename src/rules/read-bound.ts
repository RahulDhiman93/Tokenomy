import { statSync } from "node:fs";
import type { Config } from "../core/types.js";

export interface ReadBoundResult {
  kind: "passthrough" | "clamp";
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  fileBytes?: number;
  injectedLimit?: number;
  reason?: string;
}

export const readBoundRule = (
  toolInput: Record<string, unknown>,
  cfg: Config,
): ReadBoundResult => {
  if (!cfg.read.enabled) return { kind: "passthrough", reason: "disabled" };

  // Respect explicit user intent
  if (typeof toolInput["limit"] === "number") {
    return { kind: "passthrough", reason: "explicit-limit" };
  }
  if (typeof toolInput["offset"] === "number") {
    return { kind: "passthrough", reason: "explicit-offset" };
  }

  const filePath = toolInput["file_path"];
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { kind: "passthrough", reason: "no-file-path" };
  }

  let fileBytes = 0;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return { kind: "passthrough", reason: "not-a-file" };
    fileBytes = st.size;
  } catch {
    // file missing / unreadable — let the real Read surface the error
    return { kind: "passthrough", reason: "stat-failed" };
  }

  // Self-contained docs (READMEs, changelogs, plain text) read poorly when
  // clamped. If the extension matches the doc list and the file fits the doc
  // cap, let it through whole — skip the regular threshold.
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  const docExts = cfg.read.doc_passthrough_extensions ?? [];
  const docCap = cfg.read.doc_passthrough_max_bytes ?? 0;
  if (ext && docExts.includes(ext) && fileBytes <= docCap) {
    return { kind: "passthrough", reason: "doc-passthrough", fileBytes };
  }

  if (fileBytes < cfg.read.clamp_above_bytes) {
    return { kind: "passthrough", reason: "below-threshold", fileBytes };
  }

  const limit = cfg.read.injected_limit;
  return {
    kind: "clamp",
    updatedInput: { ...toolInput, limit },
    additionalContext:
      `[tokenomy: clamped Read to ${limit} lines of a ~${Math.round(fileBytes / 1024)} KB file. ` +
      `Re-Read with explicit \`offset\`+\`limit\` if you need other regions.]`,
    fileBytes,
    injectedLimit: limit,
    reason: "clamped",
  };
};
