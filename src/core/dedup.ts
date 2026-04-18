import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Config,
  HookInput,
  McpContentBlock,
  McpToolResponse,
} from "./types.js";
import { tokenomyDir } from "./paths.js";
import { resolveToolOverride } from "./config.js";
import { utf8Bytes } from "../rules/text-trim.js";

// Per-session dedup ledger. We append one JSONL record per observed (tool,
// args) call; a repeat within the configured window is a "duplicate" and
// gets replaced with a short pointer stub.
//
// File layout: ~/.tokenomy/dedup/<session-id>.jsonl
// Each line: { ts, index, key } where key = sha256(tool + canonical(args)).

interface LedgerEntry {
  ts: string;
  index: number;
  key: string;
}

const dedupDir = (): string => join(tokenomyDir(), "dedup");

const sessionLedgerPath = (sessionId: string): string => {
  // Basic sanitization: session IDs should be opaque hashes already, but
  // defend against a rogue "../" anyway.
  const safe = sessionId.replace(/[^A-Za-z0-9_\-.]/g, "_").slice(0, 128);
  return join(dedupDir(), `${safe || "unknown"}.jsonl`);
};

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value).sort();
  for (const k of keys) {
    out[k] = canonicalize((value as Record<string, unknown>)[k]);
  }
  return out;
};

export const dedupKey = (
  toolName: string,
  toolInput: Record<string, unknown>,
): string => {
  const canonical = JSON.stringify(canonicalize(toolInput ?? {}));
  return createHash("sha256")
    .update(toolName)
    .update("\u0000")
    .update(canonical)
    .digest("hex");
};

const readLedger = (sessionId: string): LedgerEntry[] => {
  const path = sessionLedgerPath(sessionId);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const out: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as LedgerEntry;
        if (typeof parsed?.key === "string") out.push(parsed);
      } catch {
        // Skip malformed lines.
      }
    }
    return out;
  } catch {
    return [];
  }
};

const appendLedger = (sessionId: string, entry: LedgerEntry): void => {
  try {
    mkdirSync(dedupDir(), { recursive: true });
    appendFileSync(sessionLedgerPath(sessionId), JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort.
  }
};

const withinWindow = (prevIso: string, windowSeconds: number): boolean => {
  const prev = Date.parse(prevIso);
  if (Number.isNaN(prev)) return false;
  return Date.now() - prev <= windowSeconds * 1_000;
};

// Build the duplicate response body — an array-shape-agnostic shape that
// preserves whatever wrapper the original response used (CallToolResult vs
// raw array).
export const duplicateResponseBody = (
  original: unknown,
  firstIndex: number,
  firstSeenIso: string,
): McpToolResponse => {
  const stubText = `[tokenomy: duplicate of call #${firstIndex} at ${firstSeenIso} — body elided, no refetch required.]`;
  const stubBlock: McpContentBlock = { type: "text", text: stubText };
  if (Array.isArray(original)) {
    return [stubBlock] as unknown as McpToolResponse;
  }
  const wrapper =
    original && typeof original === "object"
      ? { ...(original as Record<string, unknown>) }
      : {};
  wrapper["content"] = [stubBlock];
  return wrapper as McpToolResponse;
};

const responseBytes = (resp: unknown): number => {
  try {
    return utf8Bytes(JSON.stringify(resp ?? null));
  } catch {
    return 0;
  }
};

export interface DedupResult {
  duplicate: boolean;
  firstIndex?: number;
  stubOutput?: McpToolResponse;
  bytesIn: number;
  bytesOut: number;
}

export const checkAndRecordDuplicate = (
  input: HookInput,
  cfg: Config,
): DedupResult => {
  const override = resolveToolOverride(cfg, input.tool_name);
  const enabled = cfg.dedup?.enabled !== false && override?.disable_dedup !== true;
  const bytesIn = responseBytes(input.tool_response);
  if (!enabled) return { duplicate: false, bytesIn, bytesOut: bytesIn };

  const minBytes = cfg.dedup?.min_bytes ?? 2_000;
  const windowSeconds = cfg.dedup?.window_seconds ?? 1_800;

  const key = dedupKey(input.tool_name, input.tool_input ?? {});
  const ledger = readLedger(input.session_id);

  // Find the most recent prior entry with this key still within the window.
  for (let i = ledger.length - 1; i >= 0; i--) {
    const e = ledger[i]!;
    if (e.key !== key) continue;
    if (!withinWindow(e.ts, windowSeconds)) break; // anything earlier is also stale
    // Record this call so the next dup points at a stable index, then return.
    const index = ledger.length + 1;
    appendLedger(input.session_id, {
      ts: new Date().toISOString(),
      index,
      key,
    });
    // Only dedup if the original response was non-trivial — tiny responses
    // aren't worth a stub.
    if (bytesIn < minBytes) {
      return { duplicate: false, bytesIn, bytesOut: bytesIn };
    }
    const stub = duplicateResponseBody(input.tool_response, e.index, e.ts);
    const bytesOut = responseBytes(stub);
    return {
      duplicate: true,
      firstIndex: e.index,
      stubOutput: stub,
      bytesIn,
      bytesOut,
    };
  }

  // Fresh call: record and continue.
  appendLedger(input.session_id, {
    ts: new Date().toISOString(),
    index: ledger.length + 1,
    key,
  });
  return { duplicate: false, bytesIn, bytesOut: bytesIn };
};
