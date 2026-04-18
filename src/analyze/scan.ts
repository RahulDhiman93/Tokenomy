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

// Path-derived fallback identity. The parser upgrades these as soon as it
// reads a `sessionId`/`cwd` field (Claude Code) or `session_meta` event
// (Codex), but the fallback still helps when a transcript is too short to
// carry metadata. Claude Code layout: `~/.claude/projects/<project>/<session>.jsonl`.
// Codex layout: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — here both
// `project` and `session` are just placeholders until metadata upgrades them.
const fallbackIdentity = (filePath: string): { session: string; project: string } => {
  const sep = filePath.lastIndexOf("/");
  const basename = sep >= 0 ? filePath.slice(sep + 1) : filePath;
  const sessionId = basename.replace(/\.jsonl$/, "");
  const dir = sep >= 0 ? filePath.slice(0, sep) : "";
  const dirSep = dir.lastIndexOf("/");
  const project = dirSep >= 0 ? dir.slice(dirSep + 1) : dir;
  return { session: sessionId, project };
};

// File-level prefilter: only `--since` uses mtime since the other filters
// depend on metadata inside the file. Session/project filters are applied
// at emit-time on the ToolCall's authoritative identifiers.
const passesMtimeFilter = (filePath: string, since: Date | undefined): boolean => {
  if (!since) return true;
  try {
    return statSync(filePath).mtime >= since;
  } catch {
    return false;
  }
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
    if (!passesMtimeFilter(file, opts.since)) continue;

    const { session, project } = fallbackIdentity(file);
    const state: ParserState = makeState(session, project);
    await readFileLines(file, (line, bytes) => {
      lineCount++;
      byteCount += bytes;
      feedLine(line, state, (call) => {
        // Post-emit filtering uses the authoritative identity carried on
        // the ToolCall (set by upgradeIdentity inside the parser).
        if (opts.since && call.ts) {
          const t = Date.parse(call.ts);
          if (Number.isFinite(t) && t < opts.since.getTime()) return;
        }
        if (opts.sessionFilter && !call.session_id.includes(opts.sessionFilter)) return;
        if (opts.projectFilter && !call.project_hint.includes(opts.projectFilter)) return;
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
