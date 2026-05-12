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

// 0.1.8+ codex round 12: non-spawning ancestor-walk repo discovery. For
// hot paths (the hook entry, statusline, anywhere a slow `git rev-parse`
// would stall under a wedged `.git`) we just walk ancestors looking for
// a `.git` dir/file and treat that ancestor as repoPath. No subprocess.
// Falls back to `cwd` when no `.git` ancestor is found.
//
// Caveat: returns the directory CONTAINING `.git`, which for a git
// worktree's `.git` *file* is the worktree's own dir (matches what
// `git rev-parse --show-toplevel` returns). Bare clones / submodules
// with non-standard layouts won't resolve identically to git's view,
// but the hook path can tolerate that — config files live at the dir
// containing `.git`, which is what users edit.
export const resolveRepoIdSync = (cwd: string): RepoIdentity => {
  let dir = resolve(cwd);
  let repoPath = dir;
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      repoPath = dir;
      break;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return { repoId: sha256String(repoPath), repoPath };
};
