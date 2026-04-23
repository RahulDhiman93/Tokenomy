import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_CLAUDE_PROJECTS, DEFAULT_CODEX_SESSIONS } from "./scan.js";
import { golemTunePath } from "../core/paths.js";
import type { GolemMode, GolemTuneState } from "../rules/golem.js";

// Mine recent transcripts for per-session assistant-reply sizes and recommend
// a Golem mode. Strategy: compute each session's p95 reply size (bytes),
// then take the median p95 across sessions to avoid a single chatty session
// over-escalating the whole account.

const p95 = (sorted: number[]): number => {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.95 * sorted.length) - 1));
  return sorted[idx] ?? 0;
};

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

const collectFilesSince = (roots: string[], since: Date | undefined): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && e.endsWith(".jsonl")) {
        if (since && st.mtime < since) continue;
        out.push(full);
      }
    }
  };
  for (const r of roots) if (r && existsSync(r)) walk(r);
  return out.sort();
};

// Extract assistant reply text bytes per line. Handles both Claude Code
// (assistant message with content blocks) and Codex rollout (response_item
// payload of type "message" with role "assistant"). Fail-open: unparseable
// lines are silently skipped.
const replyBytesFromLine = (line: string): number | null => {
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // Claude Code
  if (obj["type"] === "assistant") {
    const msg = obj["message"];
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      const content = (msg as Record<string, unknown>)["content"];
      if (Array.isArray(content)) {
        let total = 0;
        for (const b of content) {
          if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
            const t = (b as { text?: unknown }).text;
            if (typeof t === "string") total += Buffer.byteLength(t, "utf8");
          }
        }
        return total > 0 ? total : null;
      }
    }
  }
  // Codex rollout: response_item.payload of type "message" with role assistant.
  if (obj["type"] === "response_item") {
    const payload = obj["payload"];
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const p = payload as Record<string, unknown>;
      if (p["type"] === "message" && p["role"] === "assistant") {
        const content = p["content"];
        if (Array.isArray(content)) {
          let total = 0;
          for (const b of content) {
            if (b && typeof b === "object") {
              const t = (b as { text?: unknown }).text;
              if (typeof t === "string") total += Buffer.byteLength(t, "utf8");
            }
          }
          return total > 0 ? total : null;
        }
      }
    }
  }
  return null;
};

// Map median-of-session-p95 bytes → mode. Thresholds are documented in the
// plan; tuned conservatively so a normal coding day lands on "full", not
// "grunt".
const pickMode = (medianP95Bytes: number): GolemMode => {
  if (medianP95Bytes >= 5_000) return "grunt";
  if (medianP95Bytes >= 2_000) return "ultra";
  if (medianP95Bytes >= 800) return "full";
  return "lite";
};

const confidenceFor = (sessions: number): "low" | "medium" | "high" => {
  if (sessions >= 20) return "high";
  if (sessions >= 5) return "medium";
  return "low";
};

export interface GolemTuneResult {
  state: GolemTuneState;
  medianP95Bytes: number;
  sessionCount: number;
  sessionP95s: number[];
}

export const computeGolemTune = (options: { since?: Date }): GolemTuneResult => {
  const roots = [DEFAULT_CLAUDE_PROJECTS(), DEFAULT_CODEX_SESSIONS()];
  const files = collectFilesSince(roots, options.since);
  const perSessionP95: number[] = [];
  for (const file of files) {
    let data: string;
    try {
      data = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const replySizes: number[] = [];
    for (const line of data.split("\n")) {
      const b = replyBytesFromLine(line);
      if (b !== null && b > 0) replySizes.push(b);
    }
    if (replySizes.length === 0) continue;
    replySizes.sort((a, b) => a - b);
    perSessionP95.push(p95(replySizes));
  }
  const medianP95Bytes = Math.round(median(perSessionP95));
  const mode = pickMode(medianP95Bytes);
  const sessionCount = perSessionP95.length;
  const state: GolemTuneState = {
    mode,
    confidence: confidenceFor(sessionCount),
    window_sessions: sessionCount,
    last_updated_ts: new Date().toISOString(),
    reasoning:
      sessionCount === 0
        ? "no reply data in window — defaulted to `lite` (safest fallback)"
        : `median-of-session-p95 assistant reply = ${medianP95Bytes} bytes over ` +
          `${sessionCount} session${sessionCount === 1 ? "" : "s"} → mode=${mode} ` +
          `(thresholds: <800→lite, <2000→full, <5000→ultra, ≥5000→grunt)`,
  };
  return { state, medianP95Bytes, sessionCount, sessionP95s: perSessionP95 };
};

export const writeGolemTune = (state: GolemTuneState): string => {
  const path = golemTunePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  return path;
};
