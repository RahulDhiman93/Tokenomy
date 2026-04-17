import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { sha256String } from "./hash.js";

export interface RepoIdentity {
  repoId: string;
  repoPath: string;
}

const resolveGitRoot = (cwd: string): string | null => {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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
