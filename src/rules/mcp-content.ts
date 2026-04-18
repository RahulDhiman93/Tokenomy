import type { Config, McpContentBlock, McpToolResponse, Rule } from "../core/types.js";
import { buildRecoveryHint } from "../core/recovery.js";
import { resolveToolOverride } from "../core/config.js";
import { headTailTrim, utf8Bytes } from "./text-trim.js";
import { BUILTIN_PROFILES, applyProfile, selectProfile } from "./profiles.js";
import { collapseStacktrace } from "./stacktrace.js";
import { redactSecrets, BUILTIN_PATTERNS } from "./redact.js";

const isTextBlock = (b: McpContentBlock): b is { type: "text"; text: string } =>
  b.type === "text" && typeof (b as { text?: unknown }).text === "string";

const activeProfiles = (cfg: Config) => {
  const disabled = new Set(cfg.mcp.disabled_profiles ?? []);
  const builtins = BUILTIN_PROFILES.filter((p) => !disabled.has(p.name));
  const user = cfg.mcp.profiles ?? [];
  // User profiles first so ties in specificity resolve in their favor.
  return [...user, ...builtins];
};

// Attempt a schema-aware trim on each text block. Returns a shape-preserved
// block list (may be the same refs if no profile applied) and the count of
// blocks that were compressed by a profile.
const applyProfilesToBlocks = (
  toolName: string,
  blocks: McpContentBlock[],
  cfg: Config,
): { blocks: McpContentBlock[]; applied: number; profileName: string | null } => {
  const profile = selectProfile(toolName, activeProfiles(cfg));
  if (!profile) return { blocks, applied: 0, profileName: null };

  let applied = 0;
  const next = blocks.map((b) => {
    if (!isTextBlock(b)) return b;
    const r = applyProfile(b.text, profile);
    if (!r.ok || !r.trimmed) return b;
    applied++;
    return { type: "text" as const, text: r.trimmed };
  });
  return { blocks: next, applied, profileName: profile.name };
};

export const mcpContentRule: Rule = (toolName, _toolInput, toolResponse, cfg) => {
  if (!toolResponse || typeof toolResponse !== "object") return { kind: "passthrough" };

  // Claude Code surfaces MCP tool_response in one of two shapes:
  //   1. The raw content array, e.g. [{type:"text",text:"..."}]
  //   2. The CallToolResult object, e.g. {content: [...], is_error: false}
  // We must preserve the original shape when returning updatedMCPToolOutput.
  const isArrayShape = Array.isArray(toolResponse);
  const content: unknown = isArrayShape
    ? (toolResponse as unknown[])
    : (toolResponse as McpToolResponse).content;
  if (!Array.isArray(content)) return { kind: "passthrough" };

  const rawBlocks = content as McpContentBlock[];
  const toolOverride = resolveToolOverride(cfg, toolName);
  let textBytesIn = 0;
  for (const b of rawBlocks) {
    if (isTextBlock(b)) textBytesIn += utf8Bytes(b.text);
  }

  // Stage 0: redact secrets. Runs first so later stages can't accidentally
  // surface a stub-preserved fragment of a credential.
  let redactCount = 0;
  const redactEnabled =
    cfg.redact?.enabled !== false && toolOverride?.disable_redact !== true;
  const patterns = redactEnabled
    ? BUILTIN_PATTERNS.filter(
        (p) => !(cfg.redact?.disabled_patterns ?? []).includes(p.name),
      )
    : [];
  const afterRedact = redactEnabled
    ? rawBlocks.map((b) => {
        if (!isTextBlock(b)) return b;
        const r = redactSecrets(b.text, patterns);
        if (r.total === 0) return b;
        redactCount += r.total;
        return { type: "text" as const, text: r.redacted };
      })
    : rawBlocks;

  // Stage 1: stack-trace collapse for error responses. Runs before profile
  // matching because errors often come back as plain text regardless of tool.
  let stacktraceApplied = 0;
  const stacktraceEnabled = toolOverride?.disable_stacktrace !== true;
  const afterStacktrace = stacktraceEnabled
    ? afterRedact.map((b) => {
        if (!isTextBlock(b)) return b;
        const r = collapseStacktrace(b.text);
        if (!r.ok || !r.trimmed) return b;
        stacktraceApplied++;
        return { type: "text" as const, text: r.trimmed };
      })
    : afterRedact;

  // Stage 2: profile-based schema-aware compression.
  const profileResult =
    toolOverride?.disable_profiles === true
      ? { blocks: afterStacktrace, applied: 0, profileName: null as string | null }
      : applyProfilesToBlocks(toolName, afterStacktrace, cfg);
  const blocks = profileResult.blocks;
  let postProfileBytes = 0;
  for (const b of blocks) {
    if (isTextBlock(b)) postProfileBytes += utf8Bytes(b.text);
  }

  // If neither the original nor profile-compressed version exceeds the budget,
  // passthrough is the right answer — but if a profile DID apply we still
  // return a trim result, since structure-preserving compression is the win.
  if (postProfileBytes <= cfg.mcp.max_text_bytes) {
    if (
      profileResult.applied === 0 &&
      stacktraceApplied === 0 &&
      redactCount === 0
    ) {
      return { kind: "passthrough" };
    }

    const output: McpToolResponse = isArrayShape
      ? (blocks as unknown as McpToolResponse)
      : { ...(toolResponse as McpToolResponse), content: blocks };
    const reasonParts: string[] = [];
    if (redactCount > 0) reasonParts.push(`redact:${redactCount}`);
    if (stacktraceApplied > 0) reasonParts.push("stacktrace");
    if (profileResult.applied > 0) reasonParts.push(`profile:${profileResult.profileName}`);
    return {
      kind: "trim",
      output,
      bytesIn: textBytesIn,
      bytesOut: postProfileBytes,
      reason: reasonParts.join("+") || "no-op",
    };
  }

  const newContent: McpContentBlock[] = [];
  let budgetLeft = cfg.mcp.max_text_bytes;
  let textTrimmed = false;

  for (const block of blocks) {
    if (!isTextBlock(block)) {
      newContent.push(block);
      continue;
    }
    const blockBytes = utf8Bytes(block.text);
    if (!textTrimmed && blockBytes <= budgetLeft) {
      newContent.push(block);
      budgetLeft -= blockBytes;
      continue;
    }
    if (!textTrimmed) {
      const trimmedText = headTailTrim(
        block.text,
        cfg.mcp.per_block_head,
        cfg.mcp.per_block_tail,
      );
      newContent.push({ type: "text", text: trimmedText });
      textTrimmed = true;
    } else {
      newContent.push({
        type: "text",
        text: "[tokenomy: subsequent text block elided]",
      });
    }
  }

  let textBytesOut = 0;
  for (const b of newContent) {
    if (isTextBlock(b)) textBytesOut += utf8Bytes(b.text);
  }

  newContent.push({
    type: "text",
    text: buildRecoveryHint(toolName, textBytesIn, textBytesOut),
  });
  textBytesOut += utf8Bytes(
    (newContent[newContent.length - 1] as { text: string }).text,
  );

  const output: McpToolResponse = isArrayShape
    ? (newContent as unknown as McpToolResponse)
    : { ...(toolResponse as McpToolResponse), content: newContent };

  const reasonParts: string[] = [];
  if (redactCount > 0) reasonParts.push(`redact:${redactCount}`);
  if (stacktraceApplied > 0) reasonParts.push("stacktrace");
  if (profileResult.applied > 0) reasonParts.push(`profile:${profileResult.profileName}`);
  reasonParts.push("mcp-content-trim");
  const reason = reasonParts.join("+");

  return {
    kind: "trim",
    output,
    bytesIn: textBytesIn,
    bytesOut: textBytesOut,
    reason,
  };
};
