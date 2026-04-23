import { utf8Bytes } from "./text-trim.js";

// Identify a stack-trace-like line. Supports the common shapes seen across
// languages: Node ("at foo (file:line:col)"), Python ("File \"...\", line N"),
// Java/Kotlin ("at com.x.Y.z(Y.java:42)"), Ruby ("from file:line:in `sym'").
const FRAME_RE =
  /^(\s*)(?:at\s+|File\s+"|from\s+)[^\n]*$|^(\s*)\S+\.\S+\([^)]+:\d+(:\d+)?\)\s*$|^\s*\d+:\s+\S+.*$|^\s*\S+(?:\.\S+)+\(.*\)\s*$|^\s+at\s+\S+:\d+(:\d+)?\s*$/;

export const looksLikeFrame = (line: string): boolean => FRAME_RE.test(line);

// Heuristic: a text block "looks like an error" if:
//   - it contains at least 6 consecutive stack frames, OR
//   - it starts with a keyword like Error/Traceback/Exception
const ERROR_HEAD_RE =
  /^\s*(Error|Traceback|Exception|Uncaught|Unhandled|RuntimeError|TypeError|ValueError|KeyError|AttributeError|NullPointerException|Fatal|Panic|PANIC)\b/;

export const looksLikeStacktrace = (text: string): boolean => {
  if (ERROR_HEAD_RE.test(text)) return true;
  const lines = text.split("\n");
  let run = 0;
  for (const line of lines) {
    if (looksLikeFrame(line)) {
      run++;
      if (run >= 6) return true;
    } else {
      run = 0;
    }
  }
  return false;
};

export interface CollapseResult {
  ok: boolean;
  trimmed?: string;
  bytesIn: number;
  bytesOut: number;
  reason: string;
}

// Collapse a stack trace into: (1) leading error-header lines, (2) first frame,
// (3) elided-N-frames marker, (4) last 3 frames. Preserves blank-line spacing.
export const collapseStacktrace = (
  text: string,
  opts: { keep_head_frames?: number; keep_tail_frames?: number } = {},
): CollapseResult => {
  const keepHead = opts.keep_head_frames ?? 1;
  const keepTail = opts.keep_tail_frames ?? 3;
  const bytesIn = utf8Bytes(text);
  if (!looksLikeStacktrace(text)) {
    return { ok: false, bytesIn, bytesOut: bytesIn, reason: "not-stacktrace" };
  }

  const lines = text.split("\n");
  const frameIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeFrame(lines[i]!)) frameIdx.push(i);
  }

  if (frameIdx.length < keepHead + keepTail + 2) {
    return { ok: false, bytesIn, bytesOut: bytesIn, reason: "too-few-frames" };
  }

  const firstFrameLine = frameIdx[0]!;
  const headEnd = frameIdx[keepHead - 1]!; // last index of kept head frames
  const tailStart = frameIdx[frameIdx.length - keepTail]!;

  // Preserve everything up to and including the head frames (headers + first N).
  const preamble = lines.slice(0, headEnd + 1);
  const tail = lines.slice(tailStart);
  const elidedFrames = frameIdx.length - keepHead - keepTail;

  const out = [
    ...preamble,
    `  [tokenomy: elided ${elidedFrames} middle stack frames]`,
    ...tail,
  ].join("\n");

  const bytesOut = utf8Bytes(out);
  if (bytesOut >= bytesIn) {
    return { ok: false, bytesIn, bytesOut, reason: "no-savings" };
  }
  return { ok: true, trimmed: out, bytesIn, bytesOut, reason: "stacktrace-collapsed" };
};
