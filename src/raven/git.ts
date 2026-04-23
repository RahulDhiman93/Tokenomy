import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { resolveRepoId } from "../graph/repo-id.js";
import type { RavenFileStat, RavenResult } from "./schema.js";

export interface RavenGitState {
  repo_id: string;
  root: string;
  branch: string;
  head_sha: string;
  dirty: boolean;
  staged_files: string[];
  unstaged_files: string[];
  untracked_files: string[];
  changed_files: string[];
  stats: RavenFileStat[];
}

const git = (cwd: string, args: string[]): string | null => {
  const out = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (out.status !== 0) return null;
  return out.stdout.trimEnd();
};

const uniqueSorted = (values: string[]): string[] => [...new Set(values)].sort();

const parseStatus = (
  porcelain: string,
): Pick<RavenGitState, "staged_files" | "unstaged_files" | "untracked_files" | "changed_files" | "dirty"> => {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (!line) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const raw = line.slice(3);
    const file = raw.includes(" -> ") ? raw.split(" -> ").pop() ?? raw : raw;
    if (x === "?" && y === "?") {
      untracked.push(file);
      continue;
    }
    if (x !== " ") staged.push(file);
    if (y !== " ") unstaged.push(file);
  }
  const changed_files = uniqueSorted([...staged, ...unstaged, ...untracked]);
  return {
    staged_files: uniqueSorted(staged),
    unstaged_files: uniqueSorted(unstaged),
    untracked_files: uniqueSorted(untracked),
    changed_files,
    dirty: changed_files.length > 0,
  };
};

const parseNumstat = (stdout: string): RavenFileStat[] =>
  stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [a, d, ...rest] = line.split("\t");
      const file = rest.join("\t");
      return {
        file,
        additions: a === "-" ? 0 : parseInt(a ?? "0", 10) || 0,
        deletions: d === "-" ? 0 : parseInt(d ?? "0", 10) || 0,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file));

export const currentHeadSha = (cwd: string): RavenResult<string> => {
  const sha = git(cwd, ["rev-parse", "HEAD"]);
  if (!sha) return { ok: false, reason: "git-head-unavailable", hint: "Run Raven in a git repository with at least one commit." };
  return { ok: true, data: sha };
};

export const collectGitState = (cwd: string): RavenResult<RavenGitState> => {
  const identity = resolveRepoId(cwd);
  const root = resolve(identity.repoPath);
  const head = currentHeadSha(root);
  if (!head.ok) return head;
  const branch = git(root, ["branch", "--show-current"]) || git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
  const porcelain = git(root, ["status", "--porcelain"]) ?? "";
  const status = parseStatus(porcelain);
  const statOut = git(root, ["diff", "--numstat", "HEAD"]) ?? "";
  const stats = parseNumstat(statOut);
  return {
    ok: true,
    data: {
      repo_id: identity.repoId,
      root,
      branch,
      head_sha: head.data,
      ...status,
      stats,
    },
  };
};

export const diffForFile = (cwd: string, file: string): string => {
  const unstaged = git(cwd, ["diff", "--", file]) ?? "";
  const staged = git(cwd, ["diff", "--cached", "--", file]) ?? "";
  return [staged, unstaged].filter(Boolean).join("\n");
};
