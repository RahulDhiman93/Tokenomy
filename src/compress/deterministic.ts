import { Buffer } from "node:buffer";

export interface CompressStats {
  bytesIn: number;
  bytesOut: number;
  bytesSaved: number;
  pctSaved: number;
}

export interface DeterministicCompressResult {
  text: string;
  stats: CompressStats;
}

const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;
const BULLET_RE = /^(\s*)([-*+]|\d+[.)])\s+(.+?)\s*$/;
const URL_RE = /\b(?:https?|ftp|file):\/\/\S+/i;

export const containsNulByte = (buf: Buffer): boolean => buf.includes(0);

const statsFor = (before: string, after: string): CompressStats => {
  const bytesIn = Buffer.byteLength(before, "utf8");
  const bytesOut = Buffer.byteLength(after, "utf8");
  const bytesSaved = Math.max(0, bytesIn - bytesOut);
  return {
    bytesIn,
    bytesOut,
    bytesSaved,
    pctSaved: bytesIn === 0 ? 0 : bytesSaved / bytesIn,
  };
};

interface Segment {
  protected: boolean;
  lines: string[];
}

const isFence = (line: string): boolean => /^\s*```/.test(line);
const isIndentedCode = (line: string): boolean => /^( {4}|\t)\S/.test(line);

const splitSegments = (text: string): Segment[] => {
  const lines = text.split("\n");
  const out: Segment[] = [];
  let plain: string[] = [];
  const flushPlain = (): void => {
    if (plain.length > 0) out.push({ protected: false, lines: plain });
    plain = [];
  };

  let i = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
    if (end > 0) {
      out.push({ protected: true, lines: lines.slice(0, end + 1) });
      i = end + 1;
    }
  }

  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isFence(line)) {
      flushPlain();
      const block = [line];
      i++;
      for (; i < lines.length; i++) {
        const inner = lines[i] ?? "";
        block.push(inner);
        if (isFence(inner)) break;
      }
      out.push({ protected: true, lines: block });
      continue;
    }
    if (isIndentedCode(line)) {
      flushPlain();
      const block = [line];
      i++;
      for (; i < lines.length; i++) {
        const inner = lines[i] ?? "";
        if (inner.length > 0 && !isIndentedCode(inner)) {
          i--;
          break;
        }
        block.push(inner);
      }
      out.push({ protected: true, lines: block });
      continue;
    }
    plain.push(line);
  }
  flushPlain();
  return out;
};

const normalizedHeader = (line: string): string | null => {
  const m = HEADER_RE.exec(line.trim());
  return m?.[1] && m[2] ? `${m[1]}:${m[2].trim().toLowerCase()}` : null;
};

const normalizedBullet = (line: string): string | null => {
  const m = BULLET_RE.exec(line);
  return m?.[1] !== undefined && m[3]
    ? `${m[1].length}:${m[3].trim().replace(/\s+/g, " ").toLowerCase()}`
    : null;
};

const compressPlain = (lines: string[]): string[] => {
  const stripped = lines.map((line) => line.replace(/[ \t]+$/g, ""));
  const joined: string[] = [];
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i] ?? "";
    const next = stripped[i + 1] ?? "";
    if (
      /[A-Za-z]-$/.test(line) &&
      /^[a-z]/.test(next.trimStart()) &&
      !URL_RE.test(line) &&
      !URL_RE.test(next)
    ) {
      joined.push(line.slice(0, -1) + next.trimStart());
      i++;
      continue;
    }
    joined.push(line);
  }

  const out: string[] = [];
  let blankRun = 0;
  let lastHeader: string | null = null;
  let lastBullet: string | null = null;
  for (const line of joined) {
    if (line.trim() === "") {
      blankRun++;
      lastBullet = null;
      if (blankRun <= 1) out.push("");
      continue;
    }
    blankRun = 0;

    const header = normalizedHeader(line);
    if (header && header === lastHeader) continue;
    lastHeader = header;

    const bullet = normalizedBullet(line);
    if (bullet && bullet === lastBullet) continue;
    lastBullet = bullet;
    if (!bullet) lastBullet = null;
    out.push(line);
  }
  return out;
};

export const compressDeterministic = (text: string): DeterministicCompressResult => {
  const trailingNewline = text.endsWith("\n");
  const lines = splitSegments(text).flatMap((segment) =>
    segment.protected ? segment.lines : compressPlain(segment.lines),
  );
  let out = lines.join("\n");
  if (trailingNewline && !out.endsWith("\n")) out += "\n";
  if (!trailingNewline && out.endsWith("\n")) out = out.slice(0, -1);
  return { text: out, stats: statsFor(text, out) };
};
