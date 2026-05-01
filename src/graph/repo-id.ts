import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256String } from "./hash.js";

export interface RepoIdentity {
  repoId: string;
  repoPath: string;
}

// 0.1.7+: hard timeout on `git rev-parse`. Same hang-class as the Codex
// MCP probe — a wedged `.git/index.lock`, NFS stall, or fsmonitor freeze
// would otherwise pin every MCP graph tool call indefinitely. The hook
// path has a 1s watchdog, but the MCP server has none.
const GIT_RESOLVE_TIMEOUT_MS = 1_500;

const resolveGitRoot = (cwd: string): string | null => {
  // Cheap-gate: skip the git spawn entirely when no `.git` is in the
  // ancestor chain. Common case for test fixtures, tmp dirs, and
  // non-repo cwds. Walks all the way to the filesystem root — capping
  // at 10 levels missed deep monorepo cwds (codex round 1 catch).
  let dir = resolve(cwd);
  let hit = false;
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      hit = true;
      break;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  if (!hit) return null;
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_RESOLVE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    }).trim();
    return out.length > 0 ? resolve(out) : null;
  } catch {
    return null;
  }
};

export const resolveRepoId = (cwd: string): RepoIdentity => {
  const repoPath = resolveGitRoot(cwd) ?? resolve(cwd);
  return { repoId: sha256String(resolve(repoPath)), repoPath: resolve(repoPath) };
};
