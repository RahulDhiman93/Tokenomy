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
  // Files committed on this branch but not on the base ref. Empty when no
  // base ref resolves (detached HEAD, no remotes, or branch == base).
  committed_files: string[];
  // Resolved base ref used for the committed-files diff (e.g. "origin/main",
  // "main"). null when no usable base was found.
  base_ref: string | null;
  // Union of staged + unstaged + untracked + committed (committed gives us
  // the branch's full footprint even when the working tree is clean —
  // without this, Raven packets on already-committed branches were empty).
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
): Pick<RavenGitState, "staged_files" | "unstaged_files" | "untracked_files" | "dirty"> => {
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
  const dirty = staged.length + unstaged.length + untracked.length > 0;
  return {
    staged_files: uniqueSorted(staged),
    unstaged_files: uniqueSorted(unstaged),
    untracked_files: uniqueSorted(untracked),
    dirty,
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

// Resolve the branch's base ref so we can surface committed-but-not-merged
// changes. Order: explicit `RAVEN_BASE_REF` env, then origin/HEAD's symref,
// then origin/main, origin/master, main, master. Returns null when no
// candidate exists OR the candidate is the current HEAD itself (a clean
// trunk checkout has no work to compare against).
//
// We also gate on `merge-base` resolving — `git diff base...HEAD` requires
// a shared ancestor; without one (orphan branch, brand-new repo) the diff
// would be misleading or fail.
export const resolveBaseRef = (cwd: string, currentBranch: string): string | null => {
  const env = process.env["RAVEN_BASE_REF"];
  const candidates: string[] = [];
  if (env && env.length > 0) candidates.push(env);
  const originHead = git(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) candidates.push(originHead);
  candidates.push("origin/main", "origin/master", "main", "master");
  const seen = new Set<string>();
  for (const ref of candidates) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    if (ref === currentBranch) continue;
    if (git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === null) continue;
    if (git(cwd, ["merge-base", ref, "HEAD"]) === null) continue;
    return ref;
  }
  return null;
};

const committedFiles = (cwd: string, baseRef: string): string[] => {
  const out = git(cwd, ["diff", "--name-only", `${baseRef}...HEAD`]);
  if (!out) return [];
  return uniqueSorted(out.split("\n").filter(Boolean));
};

const committedNumstat = (cwd: string, baseRef: string): RavenFileStat[] => {
  const out = git(cwd, ["diff", "--numstat", `${baseRef}...HEAD`]);
  if (!out) return [];
  return parseNumstat(out);
};

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
  const baseRef = resolveBaseRef(root, branch);
  const committed = baseRef ? committedFiles(root, baseRef) : [];
  // Working-tree numstat catches uncommitted edits; committed numstat covers
  // the rest of the branch. Concatenated stats may double-count a file that
  // is both committed AND has further uncommitted edits — that's correct,
  // since reviewers want to see both contributions.
  const workingStats = parseNumstat(git(root, ["diff", "--numstat", "HEAD"]) ?? "");
  const branchStats = baseRef ? committedNumstat(root, baseRef) : [];
  const stats = [...branchStats, ...workingStats].sort((a, b) => a.file.localeCompare(b.file));
  const changed_files = uniqueSorted([
    ...status.staged_files,
    ...status.unstaged_files,
    ...status.untracked_files,
    ...committed,
  ]);
  return {
    ok: true,
    data: {
      repo_id: identity.repoId,
      root,
      branch,
      head_sha: head.data,
      ...status,
      committed_files: committed,
      base_ref: baseRef,
      changed_files,
      stats,
    },
  };
};

export const diffForFile = (cwd: string, file: string, baseRef?: string | null): string => {
  const unstaged = git(cwd, ["diff", "--", file]) ?? "";
  const staged = git(cwd, ["diff", "--cached", "--", file]) ?? "";
  // Always include the base...HEAD hunks when a base ref is resolved AND
  // the file actually has committed changes against it. Earlier behavior
  // suppressed the base diff whenever a local edit existed, so files that
  // had BOTH a committed change AND a working-tree edit only surfaced the
  // last delta — reviewers missed the already-committed part. Cost of
  // including both: occasional duplicate context for files where the
  // committed hunk and the unstaged hunk overlap, which reviewers handle
  // fine.
  const branch = baseRef
    ? git(cwd, ["diff", `${baseRef}...HEAD`, "--", file]) ?? ""
    : "";
  return [branch, staged, unstaged].filter(Boolean).join("\n");
};
