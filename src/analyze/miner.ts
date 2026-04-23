import { existsSync, readFileSync } from "node:fs";
import { defaultLogPath } from "../core/paths.js";
import type { SavingsLogEntry } from "../core/types.js";
import { safeParse } from "../util/json.js";

export interface MinerProposal {
  id: string;
  rationale: string;
  evidence: string;
  // Config patch as a JSON-path → value pair. Applied by config-writer.
  patch: { path: string; op: "add" | "append"; value: unknown };
}

interface LoadedEvents {
  all: SavingsLogEntry[];
}

const loadEvents = (since: Date | undefined): LoadedEvents => {
  const all: SavingsLogEntry[] = [];
  const path = defaultLogPath();
  if (!existsSync(path)) return { all };
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const e = safeParse<SavingsLogEntry>(line);
    if (!e || !e.ts) continue;
    if (since) {
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t) || t < since.getTime()) continue;
    }
    all.push(e);
  }
  return { all };
};

// Count occurrences of bash-bound:<pattern> across the log. A pattern that
// fires ≥ threshold times hints at a user who'd benefit from a custom verbose
// entry, or from re-ordering exclude_tools.
const bashMiner = (events: SavingsLogEntry[]): MinerProposal[] => {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.tool !== "Bash") continue;
    const m = /^bash-bound:(.+)$/.exec(e.reason ?? "");
    if (!m) continue;
    const pattern = m[1]!;
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  const proposals: MinerProposal[] = [];
  for (const [pattern, n] of counts) {
    // Built-in patterns already bind; we only propose custom_verbose for
    // names that DON'T match built-ins. Built-in pattern names are static.
    const BUILTIN = new Set([
      "git-log",
      "git-show",
      "find",
      "ls-recursive",
      "ps",
      "docker-logs",
      "journalctl",
      "kubectl-logs",
      "tree",
    ]);
    if (BUILTIN.has(pattern)) continue;
    if (n < 3) continue;
    proposals.push({
      id: `bash-custom-${pattern}`,
      rationale: `Bash "${pattern}" bound ${n}× recently — add to bash.custom_verbose for stable canonical naming.`,
      evidence: `bash-bound:${pattern} count=${n}`,
      patch: { path: "bash.custom_verbose", op: "append", value: pattern },
    });
  }
  return proposals;
};

// Read clamps that fire repeatedly on the same reason ("read-clamp") and
// contribute large savings might benefit from doc-passthrough: raising the
// per-file threshold and/or adding an extension to the passthrough list.
const readMiner = (events: SavingsLogEntry[]): MinerProposal[] => {
  const clampEvents = events.filter((e) => e.tool === "Read" && e.reason === "read-clamp");
  if (clampEvents.length < 20) return [];
  // Aggregate tokens saved; if very high, recommend raising injected_limit.
  const total = clampEvents.reduce((a, b) => a + (b.tokens_saved_est ?? 0), 0);
  if (total < 50_000) return [];
  return [
    {
      id: "read-raise-injected-limit",
      rationale:
        `Read clamp fired ${clampEvents.length}× saving ~${Math.round(total / 1000)}K tok. ` +
        `If most reads are docs you want in full, consider raising read.injected_limit or adding extensions to doc_passthrough_extensions.`,
      evidence: `read-clamp events=${clampEvents.length} tokens_saved_est=${total}`,
      patch: { path: "read.injected_limit", op: "add", value: 750 },
    },
  ];
};

// Redact-pre firings: if pre_tool_use is disabled and we see secrets in
// transcripts via post-trim redact, the user would benefit from enabling.
// We infer "post-trim redact fired" from mcp-content reasons containing
// "redact:N" (N>0).
const redactMiner = (events: SavingsLogEntry[]): MinerProposal[] => {
  const hits = events.filter((e) => /(?:^|\W)redact:(\d+)/.test(e.reason ?? "")).length;
  if (hits < 3) return [];
  return [
    {
      id: "redact-enable-pre-tool-use",
      rationale: `Post-trim redact fired on ${hits} responses. Enabling pre-call redact closes the symmetric leak on Bash/Write/Edit.`,
      evidence: `post-trim redact hits=${hits}`,
      patch: { path: "redact.pre_tool_use", op: "add", value: true },
    },
  ];
};

export const mineProposals = (since: Date | undefined): MinerProposal[] => {
  const { all } = loadEvents(since);
  return [...bashMiner(all), ...readMiner(all), ...redactMiner(all)];
};
