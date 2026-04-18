import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ParserState } from "./parse.js";
import { feedLine, makeState } from "./parse.js";
import type { ToolCall } from "./parse.js";

// Default Claude Code + Codex transcript locations.
export const DEFAULT_CLAUDE_PROJECTS = (): string =>
  join(homedir(), ".claude", "projects");
export const DEFAULT_CODEX_SESSIONS = (): string => join(homedir(), ".codex", "sessions");

// Recursively enumerate .jsonl files under one or more root directories. We
// deliberately stay inside the two canonical locations plus user overrides;
// there is no glob walker because we already know the layout.
export const enumerateTranscripts = (roots: string[]): string[] => {
  const out: string[] = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    collectJsonl(root, out);
  }
  return out.sort();
};

const collectJsonl = (dir: string, acc: string[]): void => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectJsonl(full, acc);
    } else if (st.isFile() && entry.endsWith(".jsonl")) {
      acc.push(full);
    }
  }
};

export interface ScanOptions {
  roots: string[];
  since?: Date;
  projectFilter?: string; // substring match against project_hint
  sessionFilter?: string;
  onProgress?: (status: { file_index: number; file_total: number; bytes_read: number; elapsed_ms: number }) => void;
  progressEveryFiles?: number;
}

const sessionFromPath = (filePath: string): { session: string; project: string } => {
  // ~/.claude/projects/<projectDir>/<sessionId>.jsonl
  // ~/.codex/sessions/<...>/rollout-*.jsonl
  const sep = filePath.lastIndexOf("/");
  const basename = sep >= 0 ? filePath.slice(sep + 1) : filePath;
  const sessionId = basename.replace(/\.jsonl$/, "");
  const dir = sep >= 0 ? filePath.slice(0, sep) : "";
  const dirSep = dir.lastIndexOf("/");
  const project = dirSep >= 0 ? dir.slice(dirSep + 1) : dir;
  return { session: sessionId, project };
};

const matchesFilters = (
  filePath: string,
  session: string,
  project: string,
  opts: ScanOptions,
): boolean => {
  if (opts.sessionFilter && !session.includes(opts.sessionFilter)) return false;
  if (opts.projectFilter && !project.includes(opts.projectFilter)) return false;
  // mtime-based since filter: skip files that haven't been touched.
  if (opts.since) {
    try {
      const mtime = statSync(filePath).mtime;
      if (mtime < opts.since) return false;
    } catch {
      return false;
    }
  }
  return true;
};

// Stream every matched transcript, feeding lines to the parser and forwarding
// normalized ToolCall records to the caller. Progress is reported at a
// per-file granularity to avoid drowning stderr on every line.
export const scan = async (
  opts: ScanOptions,
  emit: (call: ToolCall) => void,
): Promise<{ files: number; lines: number; bytes: number; elapsed_ms: number }> => {
  const files = enumerateTranscripts(opts.roots);
  const start = Date.now();
  let lineCount = 0;
  let byteCount = 0;
  let processed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const { session, project } = sessionFromPath(file);
    if (!matchesFilters(file, session, project, opts)) continue;

    const state: ParserState = makeState(session, project);
    await readFileLines(file, (line, bytes) => {
      lineCount++;
      byteCount += bytes;
      feedLine(line, state, (call) => {
        if (opts.since && call.ts) {
          const t = Date.parse(call.ts);
          if (Number.isFinite(t) && t < opts.since.getTime()) return;
        }
        emit(call);
      });
    });
    processed++;

    if (opts.onProgress) {
      const every = opts.progressEveryFiles ?? 1;
      if (processed % every === 0 || i === files.length - 1) {
        opts.onProgress({
          file_index: i + 1,
          file_total: files.length,
          bytes_read: byteCount,
          elapsed_ms: Date.now() - start,
        });
      }
    }
  }

  return {
    files: processed,
    lines: lineCount,
    bytes: byteCount,
    elapsed_ms: Date.now() - start,
  };
};

const readFileLines = (
  file: string,
  onLine: (line: string, bytes: number) => void,
): Promise<void> =>
  new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: "utf8" });
    stream.on("error", () => resolve());
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => onLine(line, Buffer.byteLength(line, "utf8") + 1));
    rl.on("close", () => resolve());
  });
