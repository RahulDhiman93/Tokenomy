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

  // 0.1.5+ argument validation. Reject malformed `limit` / `offset` BEFORE
  // honoring explicit user intent: a `limit: 1e9` would defeat the clamp
  // and let an oversized Read through. We don't reject — that would break
  // the agent's call — but we strip the bad value and fall through to the
  // normal clamp path. Same for negative offsets.
  const explicitLimit =
    typeof toolInput["limit"] === "number" ? (toolInput["limit"] as number) : undefined;
  const explicitOffset =
    typeof toolInput["offset"] === "number" ? (toolInput["offset"] as number) : undefined;
  const limitOk =
    explicitLimit !== undefined &&
    Number.isFinite(explicitLimit) &&
    explicitLimit > 0 &&
    explicitLimit <= 50_000;
  const offsetOk =
    explicitOffset !== undefined && Number.isFinite(explicitOffset) && explicitOffset >= 0;

  // 0.1.5 round-3 codex catch: when EITHER bound is invalid, DON'T
  // passthrough on the surviving bound. The host treats passthrough as
  // "use the original tool_input untouched" — meaning the bad value
  // would still reach the underlying Read. Force the call into the
  // clamp path so updatedInput (with the bad value stripped) is what
  // actually flows downstream.
  const dropKeys = new Set<string>();
  if (explicitLimit !== undefined && !limitOk) dropKeys.add("limit");
  if (explicitOffset !== undefined && !offsetOk) dropKeys.add("offset");
  if (dropKeys.size > 0) {
    toolInput = Object.fromEntries(
      Object.entries(toolInput).filter(([k]) => !dropKeys.has(k)),
    );
  }
  // Honor surviving user intent ONLY when nothing was stripped — this
  // is the all-clean path (no invalid args). Otherwise fall through.
  if (limitOk && dropKeys.size === 0) return { kind: "passthrough", reason: "explicit-limit" };
  if (offsetOk && dropKeys.size === 0) return { kind: "passthrough", reason: "explicit-offset" };

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
