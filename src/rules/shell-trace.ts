import type { Config, McpToolResponse, RuleResult } from "../core/types.js";
import { looksLikeFrame } from "./stacktrace.js";
import { utf8Bytes } from "./text-trim.js";

const TSC_RE = /^\S+\.(ts|tsx|js|jsx)\(\d+,\d+\):\s+error TS\d+:/m;

const isTextBlock = (block: unknown): block is { type: "text"; text: string; [k: string]: unknown } =>
  !!block &&
  typeof block === "object" &&
  (block as { type?: unknown }).type === "text" &&
  typeof (block as { text?: unknown }).text === "string";

export const trimShellTraceText = (
  text: string,
  opts: { keepHead: number; keepTail: number; minFrames: number },
): { text: string; framesElided: number } => {
  if (TSC_RE.test(text)) return { text, framesElided: 0 };
  const lines = text.split("\n");
  const frameIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeFrame(lines[i] ?? "")) frameIndexes.push(i);
  }
  if (frameIndexes.length < opts.minFrames) return { text, framesElided: 0 };

  const keep = new Set<number>([
    ...frameIndexes.slice(0, opts.keepHead),
    ...frameIndexes.slice(Math.max(0, frameIndexes.length - opts.keepTail)),
  ]);
  const frameSet = new Set(frameIndexes);
  const elidedTotal = Math.max(0, frameIndexes.length - keep.size);
  let markerWritten = false;
  let framesElided = 0;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!frameSet.has(i) || keep.has(i)) {
      out.push(lines[i] ?? "");
      continue;
    }
    framesElided++;
    if (!markerWritten) {
      out.push(`  [tokenomy: elided ${elidedTotal} middle stack frames]`);
      markerWritten = true;
    }
  }
  return framesElided > 0 ? { text: out.join("\n"), framesElided } : { text, framesElided: 0 };
};

export const shellTraceRule = (
  toolName: string,
  toolResponse: unknown,
  cfg: Config,
): RuleResult => {
  if (toolName !== "Bash") return { kind: "passthrough" };
  const traceCfg = cfg.mcp.shell_trace_trim;
  if (!traceCfg?.enabled) return { kind: "passthrough" };
  const response = toolResponse as McpToolResponse;
  if (!response || typeof response !== "object" || !Array.isArray(response.content)) {
    return { kind: "passthrough" };
  }

  let framesElided = 0;
  const content = response.content.map((block) => {
    if (!isTextBlock(block)) return block;
    const trimmed = trimShellTraceText(block.text, {
      keepHead: traceCfg.max_preserved_frames_head,
      keepTail: traceCfg.max_preserved_frames_tail,
      minFrames: traceCfg.min_frames_to_trigger,
    });
    framesElided += trimmed.framesElided;
    return trimmed.framesElided > 0 ? { ...block, text: trimmed.text } : block;
  });
  if (framesElided === 0) return { kind: "passthrough" };

  const output: McpToolResponse = { ...response, content };
  const bytesIn = utf8Bytes(JSON.stringify(response));
  const bytesOut = utf8Bytes(JSON.stringify(output));
  if (bytesOut >= bytesIn) return { kind: "passthrough" };
  return {
    kind: "trim",
    output,
    bytesIn,
    bytesOut,
    reason: `shell-trace-trim:${framesElided}:frames`,
  };
};

