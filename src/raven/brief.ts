import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import type { Config } from "../core/types.js";
import { readSessionState } from "../core/session-state.js";
import { loadGraphContext } from "../graph/query/common.js";
import { impactRadius } from "../graph/query/impact.js";
import { reviewContext } from "../graph/query/review.js";
import type { QueryResult } from "../graph/types.js";
import { collectGitState, currentHeadSha, diffForFile } from "./git.js";
import { renderPacketMarkdown } from "./render.js";
import type { RavenDiffEntry, RavenPacket, RavenResult } from "./schema.js";
import { ravenStoreForRepo, savePacket } from "./store.js";

export interface CreatePacketOptions {
  cwd: string;
  goal?: string;
  targetAgent?: "claude-code" | "codex" | "human";
  intent?: "review" | "handoff" | "pr-check" | "second-opinion";
  sourceAgent?: "claude-code" | "codex" | "human";
  sessionId?: string;
  project?: boolean;
  maxDiffBytes?: number;
}

const stableId = (prefix: string): string =>
  `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

const clipText = (text: string, maxBytes: number): { text: string; truncated: boolean } => {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  const keep = Math.max(0, maxBytes - 80);
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > keep) break;
    out += ch;
    used += b;
  }
  return { text: `${out}\n... (+${bytes - used} bytes dropped)\n`, truncated: true };
};

const untrackedPatch = (root: string, file: string, maxBytes: number): RavenDiffEntry | null => {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8");
    const lines = content.split("\n").map((line) => `+${line}`).join("\n");
    const { text, truncated } = clipText(`diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n${lines}`, maxBytes);
    return { file, patch: text, truncated };
  } catch {
    return null;
  }
};

const graphContext = (
  cwd: string,
  cfg: Config,
  changedFiles: string[],
): { review_context?: QueryResult<unknown>; impact_radius?: QueryResult<unknown> } | undefined => {
  if (!cfg.raven.include_graph_context || changedFiles.length === 0) return undefined;
  const context = loadGraphContext(cwd, cfg);
  if (!context.ok) {
    return {
      review_context: context,
      impact_radius: context,
    };
  }
  return {
    review_context: reviewContext(
      context.data.graph,
      { files: changedFiles },
      cfg,
      context.data.stale,
      context.data.stale_files,
    ) as QueryResult<unknown>,
    impact_radius: impactRadius(
      context.data.graph,
      { changed: changedFiles.map((file) => ({ file })) },
      cfg,
      context.data.stale,
      context.data.stale_files,
    ) as QueryResult<unknown>,
  };
};

const hotspotScores = (review: unknown): Map<string, number> => {
  const map = new Map<string, number>();
  const result = review as { ok?: boolean; data?: { hotspots?: Array<{ file?: string; score?: number }> } };
  if (!result?.ok) return map;
  for (const h of result.data?.hotspots ?? []) {
    if (h.file && typeof h.score === "number") map.set(h.file, h.score);
  }
  return map;
};

const selectDiffs = (
  root: string,
  files: string[],
  cfg: Config,
  scores: Map<string, number>,
  baseRef: string | null,
): { entries: RavenDiffEntry[]; dropped: number; truncated: boolean } => {
  const maxTotal = cfg.raven.max_diff_bytes;
  const maxFile = cfg.raven.max_file_diff_bytes;
  const ordered = [...files].sort((a, b) => {
    const score = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    if (score !== 0) return score;
    return a.localeCompare(b);
  });
  const entries: RavenDiffEntry[] = [];
  let used = 0;
  let dropped = 0;
  let truncated = false;
  for (const file of ordered) {
    const raw = diffForFile(root, file, baseRef);
    const entry = raw
      ? (() => {
          const clipped = clipText(raw, maxFile);
          return { file, patch: clipped.text, truncated: clipped.truncated };
        })()
      : untrackedPatch(root, file, maxFile);
    if (!entry) continue;
    const bytes = Buffer.byteLength(entry.patch, "utf8");
    if (used + bytes > maxTotal) {
      dropped++;
      truncated = true;
      continue;
    }
    used += bytes;
    if (entry.truncated) truncated = true;
    entries.push(entry);
  }
  return { entries, dropped, truncated };
};

const riskHints = (packet: Pick<RavenPacket, "repo" | "graph" | "git">): string[] => {
  const risks: string[] = [];
  if (packet.repo.dirty) risks.push("Working tree is dirty; verify staged vs unstaged changes before merge.");
  const review = packet.graph?.review_context as { ok?: boolean; stale?: boolean; data?: { hotspots?: unknown[] } } | undefined;
  if (review?.stale) risks.push("Graph snapshot is stale; rebuild graph before relying on impact analysis.");
  if ((review?.data?.hotspots ?? []).length > 0) risks.push("Changed files touch graph hotspots; ask for a second-opinion review.");
  if (packet.git.diff_truncated) risks.push("Diff was truncated; reviewer should inspect omitted files before final approval.");
  return risks;
};

export const buildRavenPacket = (opts: CreatePacketOptions): RavenResult<{ packet: RavenPacket; markdown: string }> => {
  const git = collectGitState(opts.cwd);
  if (!git.ok) return git;
  const cfg = loadConfig(git.data.root);
  if (!cfg.raven.enabled) return { ok: false, reason: "raven-disabled", hint: "Run `tokenomy raven enable` first." };
  // 0.1.5+: refuse to brief while merge conflicts are unresolved. Detected
  // two ways:
  //   1. Authoritative source — `git ls-files -u` lists files with stage
  //      entries > 0 (= unmerged). This is the cheap, correct check that
  //      doesn't depend on diff line shape.
  //   2. Defensive fallback — scan the diffForFile output for marker lines.
  //      Diff lines are prefixed with `+`/`-`/space, so the regex must
  //      tolerate that prefix or look at the marker shape after stripping
  //      the prefix. Codex audit caught the original regex missing
  //      `+<<<<<<<` lines.
  const unmergedRaw = (() => {
    try {
      const r = require("node:child_process").spawnSync(
        "git",
        ["ls-files", "-u", "--full-name"],
        { cwd: git.data.root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return r.status === 0 ? (r.stdout as string) : "";
    } catch {
      return "";
    }
  })();
  const lsFilesUnmerged = new Set<string>();
  for (const line of unmergedRaw.split("\n")) {
    // Format: "<mode> <sha> <stage>\t<path>"
    const tab = line.indexOf("\t");
    if (tab > 0) lsFilesUnmerged.add(line.slice(tab + 1));
  }
  // Marker regex: tolerate the leading `+`/`-`/space prefix that diff
  // hunks add, and the `++`/`+ ` prefix that `git diff --cc` uses for
  // combined diffs.
  const CONFLICT_MARKER = /^[+\- ]{0,2}<<<<<<< |^[+\- ]{0,2}=======\s*$|^[+\- ]{0,2}>>>>>>> /m;
  const conflicted = new Set<string>(lsFilesUnmerged);
  for (const f of git.data.changed_files) {
    if (conflicted.has(f)) continue;
    const d = diffForFile(git.data.root, f, git.data.base_ref);
    if (CONFLICT_MARKER.test(d)) conflicted.add(f);
  }
  if (conflicted.size > 0) {
    const list = [...conflicted];
    return {
      ok: false,
      reason: "merge-conflicts",
      hint: `Resolve merge conflicts in ${list.slice(0, 5).join(", ")}${list.length > 5 ? `, +${list.length - 5} more` : ""} before running \`tokenomy raven brief\`.`,
    };
  }
  const graph = graphContext(git.data.root, cfg, git.data.changed_files);
  const scores = hotspotScores(graph?.review_context);
  const diffs = selectDiffs(git.data.root, git.data.changed_files, cfg, scores, git.data.base_ref);
  const session = opts.sessionId && cfg.raven.include_session_state ? readSessionState(opts.sessionId) : null;
  const packet: RavenPacket = {
    schema_version: 1,
    packet_id: stableId("raven-packet"),
    created_at: new Date().toISOString(),
    repo: {
      root: git.data.root,
      repo_id: git.data.repo_id,
      branch: git.data.branch,
      head_sha: git.data.head_sha,
      ...(git.data.base_ref ? { base_ref: git.data.base_ref } : {}),
      dirty: git.data.dirty,
    },
    source: {
      ...(opts.sourceAgent ? { agent: opts.sourceAgent } : {}),
      ...(opts.sessionId ? { session_id: opts.sessionId } : {}),
    },
    ...(opts.targetAgent || opts.intent ? { target: { ...(opts.targetAgent ? { agent: opts.targetAgent } : {}), ...(opts.intent ? { intent: opts.intent } : {}) } } : {}),
    ...(opts.goal ? { goal: opts.goal } : {}),
    git: {
      staged_files: git.data.staged_files,
      unstaged_files: git.data.unstaged_files,
      untracked_files: git.data.untracked_files,
      ...(git.data.committed_files.length > 0 ? { committed_files: git.data.committed_files } : {}),
      changed_files: git.data.changed_files,
      stats: git.data.stats,
      diff_summary: diffs.entries,
      dropped_files: diffs.dropped,
      diff_truncated: diffs.truncated,
    },
    ...(graph ? { graph } : {}),
    ...(session
      ? {
          session: {
            estimated_tokens: session.running_estimated_tokens,
            recent_tools: session.recent.slice(-10).map((e) => ({ tool: e.tool, tokens: e.tokens })),
          },
        }
      : {}),
    risks: [],
    review_focus: git.data.changed_files.slice(0, 20),
    open_questions: [],
  };
  packet.risks = riskHints(packet);
  const markdown = renderPacketMarkdown(packet, opts.maxDiffBytes ?? cfg.raven.max_markdown_bytes);
  return { ok: true, data: { packet, markdown } };
};

export const createAndSaveRavenPacket = (opts: CreatePacketOptions): RavenResult<{ packet: RavenPacket; markdown: string; path: string }> => {
  const built = buildRavenPacket(opts);
  if (!built.ok) return built;
  const store = ravenStoreForRepo(built.data.packet.repo.repo_id);
  savePacket(store, built.data.packet, built.data.markdown);
  return { ok: true, data: { ...built.data, path: store.dir } };
};

export const assertPacketFresh = (packet: RavenPacket, cwd: string): RavenResult<true> => {
  const head = currentHeadSha(cwd);
  if (!head.ok) return head;
  if (head.data !== packet.repo.head_sha) {
    return {
      ok: false,
      reason: "stale-packet",
      hint: "Current HEAD differs from packet HEAD. Run `tokenomy raven brief` again.",
    };
  }
  return { ok: true, data: true };
};

export const packetDigest = (packet: RavenPacket): string =>
  createHash("sha256").update(JSON.stringify(packet)).digest("hex").slice(0, 16);
