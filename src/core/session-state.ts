import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sessionStateDir, sessionStatePath } from "./paths.js";
import { safeParse } from "../util/json.js";

// Per-session running totals used by the budget PreToolUse rule.
// Stored as append-only NDJSON under ~/.tokenomy/session/<hash>.ndjson so
// multiple concurrent hooks on the same session can update state without
// racing a read-modify-write cycle: each invocation simply appends one line.
// Totals are computed by re-scanning the file on read.

export interface SessionStateEntry {
  ts: string;
  tool: string;
  tokens: number;
}

export interface SessionState {
  session_id: string;
  started_ts: string;
  updated_ts: string;
  running_estimated_tokens: number;
  recent: SessionStateEntry[];
}

// Keep the last N entries in the "recent" view for debugging. Doesn't cap
// disk — the file grows until pruneOldSessions evicts it by age/size.
const RECENT_VIEW_CAP = 200;

// Files older than this are deleted on every updateSessionState call.
const SESSION_TTL_MS = 48 * 60 * 60 * 1000; // 48h
// And we cap total session directory size so pathological usage never fills
// the disk. If total > cap, the oldest files are deleted until under cap.
const SESSION_DIR_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

const readLedger = (path: string): SessionStateEntry[] => {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const out: SessionStateEntry[] = [];
  for (const line of lines) {
    if (!line) continue;
    const e = safeParse<SessionStateEntry>(line);
    if (!e || typeof e.tokens !== "number") continue;
    out.push(e);
  }
  return out;
};

const aggregate = (sessionId: string, entries: SessionStateEntry[]): SessionState | null => {
  if (entries.length === 0) return null;
  let total = 0;
  for (const e of entries) total += Math.max(0, e.tokens);
  const recent = entries.slice(-RECENT_VIEW_CAP);
  return {
    session_id: sessionId,
    started_ts: entries[0]!.ts,
    updated_ts: entries[entries.length - 1]!.ts,
    running_estimated_tokens: total,
    recent,
  };
};

export const readSessionState = (sessionId: string): SessionState | null => {
  try {
    const path = sessionStatePath(sessionId);
    return aggregate(sessionId, readLedger(path));
  } catch {
    return null;
  }
};

// Delete session files older than TTL, then trim by total-size if still over
// the cap. Best-effort — every failure is silently ignored so the budget
// hook never breaks because of a stale file.
const pruneOldSessions = (): void => {
  try {
    const dir = sessionStateDir();
    if (!existsSync(dir)) return;
    const now = Date.now();
    const entries: Array<{ path: string; mtimeMs: number; size: number }> = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > SESSION_TTL_MS) {
          unlinkSync(path);
          continue;
        }
        entries.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // ignore per-file issues
      }
    }
    let total = 0;
    for (const e of entries) total += e.size;
    if (total <= SESSION_DIR_MAX_BYTES) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of entries) {
      if (total <= SESSION_DIR_MAX_BYTES) break;
      try {
        unlinkSync(e.path);
        total -= e.size;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
};

export const updateSessionState = (
  sessionId: string,
  addTokens: number,
  tool: string,
): SessionState => {
  const path = sessionStatePath(sessionId);
  const entry: SessionStateEntry = {
    ts: new Date().toISOString(),
    tool,
    tokens: Math.max(0, addTokens),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Fail-open: budget gate is advisory; persistence failure must never
    // break the hook.
  }
  // Prune opportunistically on every update. Cheap O(n) scan of the small
  // session dir; amortizes cleanup across the session's natural call rate.
  pruneOldSessions();
  return (
    aggregate(sessionId, readLedger(path)) ?? {
      session_id: sessionId,
      started_ts: entry.ts,
      updated_ts: entry.ts,
      running_estimated_tokens: entry.tokens,
      recent: [entry],
    }
  );
};

export const sessionStateBaseDir = (): string => sessionStateDir();
