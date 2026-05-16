import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const expandHome = (p: string): string =>
  p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^\/+/, "")) : p;

export const tokenomyDir = (): string => join(homedir(), ".tokenomy");
export const tokenomyBinDir = (): string => join(tokenomyDir(), "bin");
export const hookBinaryPath = (): string => join(tokenomyBinDir(), "tokenomy-hook");
export const globalConfigPath = (): string => join(tokenomyDir(), "config.json");
export const manifestPath = (): string => join(tokenomyDir(), "installed.json");
export const defaultLogPath = (): string => join(tokenomyDir(), "savings.jsonl");
// Written by `tokenomy analyze --tune`; read when cfg.golem.mode === "auto".
export const golemTunePath = (): string => join(tokenomyDir(), "golem-tune.json");
// Written by `tokenomy analyze` as a side effect; read by the budget
// PreToolUse rule for p95-response-size lookups.
export const analyzeCachePath = (): string => join(tokenomyDir(), "analyze-cache.json");
// Written by `tokenomy update --check`; read by the statusline to render
// a `↑` marker after the version when a newer build exists on npm.
export const updateCachePath = (): string => join(tokenomyDir(), "update-cache.json");
// Local copy of every `tokenomy feedback` submission. Append-only JSONL.
// Survives even when the user is offline / `gh` is missing / browser
// fallback is canceled — gives them a way to resubmit later.
export const feedbackLogPath = (): string => join(tokenomyDir(), "feedback.jsonl");
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

// 0.1.8+: project registry. JSONL append-only at `~/.tokenomy/projects.json`.
// Each line: { repoRoot, repoId, registered_at, last_built_at?, raven_enabled? }.
// Drives cross-repo commands (`graph purge --all`, `raven clean --all`,
// `graph migrate`, `raven migrate`, `doctor --all-repos`). Per-repo storage
// removed the ability to enumerate via `readdirSync(~/.tokenomy/graphs/)`,
// so this is the registry that backs every cross-repo operation.
export const projectsRegistryPath = (): string =>
  join(tokenomyDir(), "projects.json");

// ---------------------------------------------------------------------------
// Per-repo storage helpers. 0.1.8+: dual-mode.
//
// - `location: "in-repo"` (default):  `<repoRoot>/.tokenomy-graph/...`
//                                     `<repoRoot>/.tokenomy-raven/...`
// - `location: "home"`   (escape hatch for read-only/CI mounts):
//                                     `~/.tokenomy/graphs/<repoId>/...`
//                                     `~/.tokenomy/raven/<repoId>/...`
//
// Every helper takes a `RepoIdentity`-shaped `{repoId, repoPath}` and a
// `StorageLocationConfig`. Both fields are required so the callsite makes
// the location decision explicitly — defensive against silent fall-through
// to the wrong layout.
// ---------------------------------------------------------------------------

export interface RepoIdentityLike {
  repoId: string;
  repoPath: string;
}

export interface StorageLocationConfig {
  location?: "in-repo" | "home";
}

const assertAbsolute = (p: string, label: string): void => {
  if (!isAbsolute(p)) {
    throw new Error(`${label} must be absolute, got ${p}`);
  }
};

// Legacy root, used only in `home` mode + by registry housekeeping.
export const legacyGraphRootDir = (): string => join(tokenomyDir(), "graphs");
// Legacy root, used only in `home` mode + by registry housekeeping.
export const legacyRavenRootDir = (): string => join(tokenomyDir(), "raven");

// Returns the per-repo graph storage directory under the configured
// location. Throws on non-absolute repoPath (defensive).
export const graphDir = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => {
  const loc = cfg?.location ?? "in-repo";
  if (loc === "home") {
    return join(legacyGraphRootDir(), identity.repoId);
  }
  assertAbsolute(identity.repoPath, "graphDir repoPath");
  return join(identity.repoPath, ".tokenomy-graph");
};

export const graphSnapshotPath = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => join(graphDir(identity, cfg), "snapshot.json");

export const graphMetaPath = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => join(graphDir(identity, cfg), "meta.json");

export const graphBuildLogPath = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => join(graphDir(identity, cfg), "build.jsonl");

export const graphLockPath = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => join(graphDir(identity, cfg), ".build.lock");

// 0.1.3+: PostToolUse Edit/Write/MultiEdit touches this sentinel; cleared
// by buildGraph after a successful rebuild. Existence = "graph definitely
// stale, skip the enumerate walk."
export const graphDirtySentinelPath = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => join(graphDir(identity, cfg), ".dirty");

// 0.1.3+: per-repo lock taken by the async background-rebuild path so
// rapid edits don't pile up rebuilds. Existence = "rebuild in flight."
export const graphRebuildLockPath = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => join(graphDir(identity, cfg), ".rebuilding");

// 0.1.8+: last async-rebuild failure recorded by the read-side
// `startBackgroundRebuild` so the next MCP query can surface it inline
// (`last_build_failure` on every cacheable response).
export const graphAsyncFailurePath = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => join(graphDir(identity, cfg), ".last-async-failure.json");

// 0.1.9+: rolling rebuild-worker stats. JSON: { count, last_ms,
// total_ms, last_ts, worker_active }. Updated each time the worker
// completes a rebuild. Surfaced in `tokenomy report` and consumed by
// `tokenomy analyze`.
export const graphRebuildStatsPath = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => join(graphDir(identity, cfg), ".rebuild-stats.json");

// 0.1.8+: per-repo Raven storage. Same dual-mode as graph.
export const ravenRepoDir = (
  identity: RepoIdentityLike,
  cfg?: StorageLocationConfig,
): string => {
  const loc = cfg?.location ?? "in-repo";
  if (loc === "home") {
    return join(legacyRavenRootDir(), identity.repoId);
  }
  assertAbsolute(identity.repoPath, "ravenRepoDir repoPath");
  return join(identity.repoPath, ".tokenomy-raven");
};

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
