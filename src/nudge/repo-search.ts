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

const escapeRegex = (token: string): string =>
  token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const queryTokens = (query: string): string[] =>
  query
    .toLowerCase()
    .split(/[^a-z0-9_@/-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .slice(0, 8);

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

// Two-stage `git grep` keeps subprocess output bounded regardless of repo
// size. A single-stage `git grep -n -E "token1|token2"` on a large codebase
// (chatbox-js: 2.7 MB of output for `provider|loader|runtime`) blows right
// through `spawnSync`'s `maxBuffer`, which returns `status: null` and an
// empty stdout, silently collapsing `repo_results` to `[]`.
//
// Stage 1: `git grep -l` → newline-delimited file list. One short line per
// matching file, bounded in practice by repo file count.
// Stage 2: `git grep -n -E` against only the first ~50 files. Per-file match
// count capped at 3 by `--max-count 3`, so output is always small.
const MAX_FILES_STAGE_TWO = 50;
const STAGE_ONE_BUFFER = 4_000_000; // ~4 MB of file paths — generous headroom.
// 50 files × 3 matches is fine for typical source lines, but repos that keep
// bundled or minified assets in-tree (cdn-src/, dist/) can have lines running
// tens of thousands of chars. 8 MB leaves enough headroom to avoid ENOBUFS.
const STAGE_TWO_BUFFER = 8_000_000;

// Relevance ranking for Stage 1: score candidate files by how many distinct
// query tokens they contain. A file matching both `useRuntimeConfig` AND
// `provider` ranks above a file matching only the common word `provider`.
// Without this, Stage 2 emits matches in git's file-tree order and `maxResults`
// cuts off the list before the actually-relevant files get a turn.
//
// Cost: one `git grep -l` spawn per token. Query tokens are capped at 8 in
// `queryTokens`; typical queries have 2-4 tokens, so 2-4 extra subprocess
// spawns (~50 ms each on a 5 000-file repo).
const rankFilesByTokenHits = (
  cwd: string,
  tokens: string[],
  opts: RepoSearchOptions,
  branch?: string,
): string[] => {
  const scores = new Map<string, number>();
  const branchPrefix = branch ? `${branch}:` : null;
  for (const token of tokens) {
    const args = branch
      ? ["grep", "-l", "-i", "-E", escapeRegex(token), branch]
      : ["grep", "-l", "-i", "-E", escapeRegex(token), "--", "."];
    const r = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: STAGE_ONE_BUFFER,
    });
    if (r.status !== 0 || !r.stdout) continue;
    for (const raw of r.stdout.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const file = branchPrefix && line.startsWith(branchPrefix)
        ? line.slice(branchPrefix.length)
        : line;
      scores.set(file, (scores.get(file) ?? 0) + 1);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file]) => file)
    .slice(0, MAX_FILES_STAGE_TWO);
};

const currentBranchMatches = (
  cwd: string,
  tokens: string[],
  opts: RepoSearchOptions,
): RepoAlternative[] => {
  // Use `git grep` (not ripgrep) — it ships with every git install, runs
  // against the working tree, and keeps tooling consistent with the
  // other-branch path below. Avoids a ripgrep dependency + ENOENT on
  // machines where `rg` is a shell alias rather than a real binary.
  const files = rankFilesByTokenHits(cwd, tokens, opts);
  if (files.length === 0) return [];
  const pattern = tokens.map(escapeRegex).join("|");
  const r = spawnSync(
    "git",
    ["grep", "-n", "-i", "-E", "--max-count", "3", pattern, "--", ...files],
    {
      cwd,
      encoding: "utf8",
      timeout: opts.timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: STAGE_TWO_BUFFER,
    },
  );
  if (r.status !== 0 || !r.stdout) return [];
  // `git grep` emits output in its own (alphabetical / tree) order regardless
  // of the pathspec argument order, so we re-sort the parsed matches against
  // the ranked file list. `Array.prototype.sort` is stable, so within-file
  // line order is preserved.
  const rank = new Map(files.map((f, i) => [f, i]));
  return r.stdout
    .split("\n")
    .map((line) => parseGrepLine(line, "current-branch"))
    .filter((entry): entry is RepoAlternative => entry !== null)
    .sort((a, b) => (rank.get(a.file) ?? Infinity) - (rank.get(b.file) ?? Infinity))
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
  tokens: string[],
  opts: RepoSearchOptions,
  already: number,
): RepoAlternative[] => {
  const out: RepoAlternative[] = [];
  const pattern = tokens.map(escapeRegex).join("|");
  for (const branch of branchNames(cwd, opts.timeoutMs)) {
    if (out.length + already >= opts.maxResults) break;
    const files = rankFilesByTokenHits(cwd, tokens, opts, branch);
    if (files.length === 0) continue;
    const r = spawnSync(
      "git",
      ["grep", "-n", "-i", "-E", "--max-count", "3", pattern, branch, "--", ...files],
      {
        cwd,
        encoding: "utf8",
        timeout: opts.timeoutMs,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: STAGE_TWO_BUFFER,
      },
    );
    if (r.status !== 0 || !r.stdout) continue;
    // `git grep` doesn't honor pathspec argument order; re-sort by ranking.
    const rank = new Map(files.map((f, i) => [f, i]));
    const branchMatches: RepoAlternative[] = [];
    for (const line of r.stdout.split("\n")) {
      const withoutBranch = line.startsWith(`${branch}:`)
        ? line.slice(branch.length + 1)
        : line;
      const parsed = parseGrepLine(withoutBranch, "other-branch", branch);
      if (parsed) branchMatches.push(parsed);
    }
    branchMatches.sort(
      (a, b) => (rank.get(a.file) ?? Infinity) - (rank.get(b.file) ?? Infinity),
    );
    for (const entry of branchMatches) {
      out.push(entry);
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
  const tokens = queryTokens(query);
  if (tokens.length === 0) {
    return fail("invalid-input", "repo search query has no searchable tokens");
  }
  // Non-git worktrees (tmp dirs, pre-init projects) still have source files we
  // should surface — fall back to a filesystem walk so the tool isn't silently
  // empty outside a repo.
  if (!isGitWorktree(cwd, opts.timeoutMs)) {
    const pattern = tokens.map(escapeRegex).join("|");
    return { ok: true, results: walkMatches(cwd, pattern, opts) };
  }
  const current = currentBranchMatches(cwd, tokens, opts);
  const other = otherBranchMatches(cwd, tokens, opts, current.length);
  return { ok: true, results: [...current, ...other].slice(0, opts.maxResults) };
};
