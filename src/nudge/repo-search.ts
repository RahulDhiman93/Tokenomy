import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface RepoSearchOptions {
  timeoutMs: number;
  maxResults: number;
}

export interface RepoAlternative {
  source: "current-branch" | "other-branch";
  branch?: string;
  file: string;
  line?: number;
  snippet?: string;
  fit_reason: string;
}

export interface RepoSearchOk {
  ok: true;
  results: RepoAlternative[];
}

export type RepoSearchResult = RepoSearchOk | { ok: false; reason: string; hint?: string };

const fail = (reason: string, hint?: string): RepoSearchResult => ({
  ok: false,
  reason,
  ...(hint ? { hint } : {}),
});

const queryPattern = (query: string): string | null => {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_@/-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
};

const parseGrepLine = (
  line: string,
  source: RepoAlternative["source"],
  branch?: string,
): RepoAlternative | null => {
  const parts = line.split(":");
  if (parts.length < 3) return null;
  const file = parts.shift();
  const lineRaw = parts.shift();
  if (!file || !lineRaw) return null;
  const lineNo = Number.parseInt(lineRaw, 10);
  const snippet = parts.join(":").trim();
  return {
    source,
    ...(branch ? { branch } : {}),
    file,
    ...(Number.isFinite(lineNo) ? { line: lineNo } : {}),
    ...(snippet ? { snippet } : {}),
    fit_reason:
      source === "current-branch"
        ? "matching code already exists on the current branch"
        : `matching code exists on ${branch}`,
  };
};

const currentBranchMatches = (
  cwd: string,
  pattern: string,
  opts: RepoSearchOptions,
): RepoAlternative[] => {
  // Use `git grep` (not ripgrep) — it ships with every git install, runs
  // against the working tree, and keeps tooling consistent with the
  // other-branch path below. Avoids a ripgrep dependency + ENOENT on
  // machines where `rg` is a shell alias rather than a real binary.
  const r = spawnSync(
    "git",
    ["grep", "-n", "-i", "-E", "--max-count", "3", pattern, "--", "."],
    {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64_000,
    },
  );
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .split("\n")
    .map((line) => parseGrepLine(line, "current-branch"))
    .filter((entry): entry is RepoAlternative => entry !== null)
    .slice(0, opts.maxResults);
};

const branchNames = (cwd: string, timeoutMs: number): string[] => {
  const current = spawnSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  }).stdout?.trim();
  const refs = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"],
    {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64_000,
    },
  );
  if (refs.status !== 0 || !refs.stdout) return [];
  const seen = new Set<string>();
  return refs.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((branch) => branch !== current && !branch.endsWith("/HEAD"))
    .filter((branch) => {
      if (seen.has(branch)) return false;
      seen.add(branch);
      return true;
    })
    .slice(0, 20);
};

const otherBranchMatches = (
  cwd: string,
  pattern: string,
  opts: RepoSearchOptions,
  already: number,
): RepoAlternative[] => {
  const out: RepoAlternative[] = [];
  for (const branch of branchNames(cwd, opts.timeoutMs)) {
    if (out.length + already >= opts.maxResults) break;
    const r = spawnSync("git", ["grep", "-n", "-i", "-E", pattern, branch, "--", "."], {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64_000,
    });
    if (r.status !== 0 || !r.stdout) continue;
    for (const line of r.stdout.split("\n")) {
      const withoutBranch = line.startsWith(`${branch}:`)
        ? line.slice(branch.length + 1)
        : line;
      const parsed = parseGrepLine(withoutBranch, "other-branch", branch);
      if (parsed) out.push(parsed);
      if (out.length + already >= opts.maxResults) break;
    }
  }
  return out;
};

const isGitWorktree = (cwd: string, timeoutMs: number): boolean => {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && r.stdout?.trim() === "true";
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".cache",
]);

const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".py", ".go", ".java", ".kt", ".rs",
  ".rb", ".php", ".cs", ".swift", ".md", ".txt",
  ".yaml", ".yml", ".toml", ".sh", ".html", ".css", ".scss",
]);

// Pure-node fallback for cwd values that aren't git worktrees (e.g. a freshly
// `mkdir`'d project directory or a tmp tree in tests). Walks the filesystem,
// skipping vendor/build dirs and hidden files, and runs the same case-insensitive
// regex pattern we feed to `git grep`. Capped by maxResults, a per-file size
// limit, a scan count, and the caller's timeout.
const walkMatches = (
  cwd: string,
  pattern: string,
  opts: RepoSearchOptions,
): RepoAlternative[] => {
  const regex = new RegExp(pattern, "i");
  const out: RepoAlternative[] = [];
  const stack: string[] = [cwd];
  const started = Date.now();
  let filesScanned = 0;
  while (stack.length > 0 && out.length < opts.maxResults) {
    if (Date.now() - started > opts.timeoutMs) break;
    if (filesScanned > 2_000) break;
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= opts.maxResults) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".") && entry.name !== ".") continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const dotIdx = entry.name.lastIndexOf(".");
      const ext = dotIdx >= 0 ? entry.name.slice(dotIdx).toLowerCase() : "";
      if (!TEXT_EXTS.has(ext)) continue;
      let size: number;
      try {
        size = statSync(full).size;
      } catch {
        continue;
      }
      if (size > 256_000) continue;
      filesScanned += 1;
      if (filesScanned > 2_000) break;
      let contents: string;
      try {
        contents = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const lines = contents.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (regex.test(line)) {
          const rel = relative(cwd, full).split("\\").join("/");
          const snippet = line.trim().slice(0, 200);
          out.push({
            source: "current-branch",
            file: rel,
            line: i + 1,
            ...(snippet ? { snippet } : {}),
            fit_reason: "matching code already exists in the working tree",
          });
          break;
        }
      }
    }
  }
  return out;
};

export const repoSearch = (
  cwd: string,
  query: string,
  opts: RepoSearchOptions,
): RepoSearchResult => {
  const pattern = queryPattern(query);
  if (!pattern) return fail("invalid-input", "repo search query has no searchable tokens");
  // Non-git worktrees (tmp dirs, pre-init projects) still have source files we
  // should surface — fall back to a filesystem walk so the tool isn't silently
  // empty outside a repo.
  if (!isGitWorktree(cwd, opts.timeoutMs)) {
    return { ok: true, results: walkMatches(cwd, pattern, opts) };
  }
  const current = currentBranchMatches(cwd, pattern, opts);
  const other = otherBranchMatches(cwd, pattern, opts, current.length);
  return { ok: true, results: [...current, ...other].slice(0, opts.maxResults) };
};
