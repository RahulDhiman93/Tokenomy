import type { Config, McpContentBlock, McpToolResponse, Rule } from "../core/types.js";
import { buildRecoveryHint } from "../core/recovery.js";
import { headTailTrim, utf8Bytes } from "./text-trim.js";

const isTextBlock = (b: McpContentBlock): b is { type: "text"; text: string } =>
  b.type === "text" && typeof (b as { text?: unknown }).text === "string";

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

  const blocks = content as McpContentBlock[];
  let textBytesIn = 0;
  for (const b of blocks) {
    if (isTextBlock(b)) textBytesIn += utf8Bytes(b.text);
  }
  if (textBytesIn <= cfg.mcp.max_text_bytes) return { kind: "passthrough" };

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

  return {
    kind: "trim",
    output,
    bytesIn: textBytesIn,
    bytesOut: textBytesOut,
    reason: "mcp-content-trim",
  };
};
