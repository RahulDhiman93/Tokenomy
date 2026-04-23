import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const expandHome = (p: string): string =>
  p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^\/+/, "")) : p;

export const tokenomyDir = (): string => join(homedir(), ".tokenomy");
export const tokenomyBinDir = (): string => join(tokenomyDir(), "bin");
export const tokenomyGraphRootDir = (): string => join(tokenomyDir(), "graphs");
export const hookBinaryPath = (): string => join(tokenomyBinDir(), "tokenomy-hook");
export const globalConfigPath = (): string => join(tokenomyDir(), "config.json");
export const manifestPath = (): string => join(tokenomyDir(), "installed.json");
export const defaultLogPath = (): string => join(tokenomyDir(), "savings.jsonl");
// Written by `tokenomy analyze --tune`; read when cfg.golem.mode === "auto".
export const golemTunePath = (): string => join(tokenomyDir(), "golem-tune.json");
// Written by `tokenomy analyze` as a side effect; read by the budget
// PreToolUse rule for p95-response-size lookups.
export const analyzeCachePath = (): string => join(tokenomyDir(), "analyze-cache.json");
// Per-session running totals for the budget rule. Cleared on SessionStart
// of a new session. Session-state files are append-only JSONL ledgers keyed
// by a sanitized hash of the session_id (to prevent path traversal when a
// hostile session_id contains "../" or other separators).
export const sessionStateDir = (): string => join(tokenomyDir(), "session");

// Deterministic, filesystem-safe filename derived from the raw session_id.
// Uses sha256 truncated to 16 hex chars + ".ndjson" extension so two
// co-running hooks for the same session land on the same file, but a
// session_id with path separators or control chars can never escape the
// session directory.
import { createHash } from "node:crypto";
export const sessionStateSlug = (sessionId: string): string =>
  createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
export const sessionStatePath = (sessionId: string): string =>
  join(sessionStateDir(), `${sessionStateSlug(sessionId)}.ndjson`);
export const graphDir = (repoId: string): string => join(tokenomyGraphRootDir(), repoId);
export const graphSnapshotPath = (repoId: string): string =>
  join(graphDir(repoId), "snapshot.json");
export const graphMetaPath = (repoId: string): string =>
  join(graphDir(repoId), "meta.json");
export const graphBuildLogPath = (repoId: string): string =>
  join(graphDir(repoId), "build.jsonl");
export const graphLockPath = (repoId: string): string =>
  join(graphDir(repoId), ".build.lock");

export const claudeSettingsPath = (): string =>
  join(homedir(), ".claude", "settings.json");

// Claude Code 2.1+ stores MCP server registrations in ~/.claude.json
// (separate from settings.json, which only holds hooks, effortLevel,
// permissions, etc.). We write/remove our tokenomy-graph entry here so
// `claude mcp list` picks it up without the user needing to run
// `claude mcp add` manually.
export const claudeUserConfigPath = (): string =>
  join(homedir(), ".claude.json");

export const projectConfigPath = (cwd: string): string =>
  resolve(cwd, ".tokenomy.json");
