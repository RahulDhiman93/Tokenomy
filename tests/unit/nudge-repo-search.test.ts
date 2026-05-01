import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { repoSearch } from "../../src/nudge/repo-search.js";

const withGitRepo = <T>(fn: (repo: string) => T): T => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-repo-search-"));
  try {
    runGit(repo, ["init"]);
    runGit(repo, ["branch", "-M", "main"]);
    mkdirSync(join(repo, "src", "utils"), { recursive: true });
    writeFileSync(
      join(repo, "src", "utils", "retry.ts"),
      "export function retryBackoff() { return 'retry backoff'; }\n",
    );
    runGit(repo, ["add", "."]);
    runGit(repo, [
      "-c",
      "user.name=Tokenomy Test",
      "-c",
      "user.email=tokenomy@example.test",
      "commit",
      "-m",
      "initial",
    ]);
    return fn(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

const runGit = (cwd: string, args: string[]): void => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
};

test("repoSearch: returns matches from current branch", () => {
  withGitRepo((repo) => {
    const result = repoSearch(repo, "retry backoff helper", {
      timeoutMs: 5_000,
      maxResults: 5,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.results[0]?.source, "current-branch");
    assert.equal(result.results[0]?.file, "src/utils/retry.ts");
    assert.match(result.results[0]?.snippet ?? "", /retry backoff/);
  });
});

test("repoSearch: falls back to filesystem walk outside a git worktree", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-repo-search-nogit-"));
  try {
    mkdirSync(join(dir, "src", "utils"), { recursive: true });
    writeFileSync(
      join(dir, "src", "utils", "retry.ts"),
      "export function retryBackoff() { return 'retry backoff helper'; }\n",
    );
    const result = repoSearch(dir, "retry backoff helper", {
      timeoutMs: 5_000,
      maxResults: 5,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.results[0]?.source, "current-branch");
    assert.equal(result.results[0]?.file, "src/utils/retry.ts");
    assert.match(result.results[0]?.snippet ?? "", /retry backoff/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repoSearch: returns matches from another local branch", () => {
  withGitRepo((repo) => {
    runGit(repo, ["checkout", "-b", "feature/retry-cache"]);
    writeFileSync(
      join(repo, "src", "utils", "cache.ts"),
      "export const retryCache = new Map<string, number>();\n",
    );
    runGit(repo, ["add", "."]);
    runGit(repo, [
      "-c",
      "user.name=Tokenomy Test",
      "-c",
      "user.email=tokenomy@example.test",
      "commit",
      "-m",
      "add retry cache",
    ]);
    runGit(repo, ["checkout", "main"]);

    const result = repoSearch(repo, "retry cache", {
      timeoutMs: 5_000,
      maxResults: 5,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(
      result.results.some(
        (entry) =>
          entry.source === "other-branch" &&
          entry.branch === "feature/retry-cache" &&
          entry.file === "src/utils/cache.ts",
      ),
      JSON.stringify(result.results),
    );
  });
});

test("repoSearch: ranks files matching more distinct tokens ahead of common-word-only matches", () => {
  withGitRepo((repo) => {
    // File A: matches only the common token (`provider`). Represents the
    // many React components that hit `provider` incidentally.
    mkdirSync(join(repo, "src", "components"), { recursive: true });
    writeFileSync(
      join(repo, "src", "components", "ThemeWrapper.tsx"),
      [
        "import { ThemeProvider } from '@mantine/core';",
        "export const ThemeWrapper = () => (",
        "  <ThemeProvider><div /></ThemeProvider>",
        ");",
      ].join("\n"),
    );
    // File B: matches BOTH tokens (`useRuntimeConfig` + `provider`). This
    // is the genuinely-relevant file.
    mkdirSync(join(repo, "src", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, "src", "hooks", "useRuntimeConfig.ts"),
      [
        "// runtime config provider for feature flags",
        "export const useRuntimeConfig = () => {",
        "  return { provider: 'local' };",
        "};",
      ].join("\n"),
    );
    runGit(repo, ["add", "."]);
    runGit(repo, [
      "-c",
      "user.name=Tokenomy Test",
      "-c",
      "user.email=tokenomy@example.test",
      "commit",
      "-m",
      "seed relevance test",
    ]);

    const result = repoSearch(repo, "useRuntimeConfig provider", {
      timeoutMs: 10_000,
      maxResults: 5,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const firstFile = result.results[0]?.file;
    assert.equal(
      firstFile,
      "src/hooks/useRuntimeConfig.ts",
      `expected useRuntimeConfig.ts to outrank ThemeWrapper.tsx, got ${firstFile}`,
    );
  });
});

test("repoSearch: survives >64 KB of git-grep output (large-repo regression)", () => {
  withGitRepo((repo) => {
    // Seed 120 files that each match the search pattern on multiple lines.
    // With the legacy single-stage `git grep -n` + 64 KB maxBuffer, the
    // subprocess overflows with ENOBUFS, status becomes null, and repoSearch
    // silently returns []. The two-stage implementation caps Stage 1 output
    // at filenames only, then runs Stage 2 against the first 50 files.
    mkdirSync(join(repo, "src", "providers"), { recursive: true });
    const noise = "provider runtime configuration ".repeat(40);
    for (let i = 0; i < 120; i++) {
      writeFileSync(
        join(repo, "src", "providers", `Provider${i}.ts`),
        `// ${noise}\nexport const Provider${i} = () => null;\n// ${noise}\n`,
      );
    }
    runGit(repo, ["add", "."]);
    runGit(repo, [
      "-c",
      "user.name=Tokenomy Test",
      "-c",
      "user.email=tokenomy@example.test",
      "commit",
      "-m",
      "seed large repo",
    ]);

    const result = repoSearch(repo, "provider runtime configuration", {
      timeoutMs: 10_000,
      maxResults: 5,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(
      result.results.length > 0,
      "repo search must return matches even when raw git grep output exceeds 64 KB",
    );
    assert.equal(result.results[0]?.source, "current-branch");
  });
});

test("repoSearch: honors an already-expired global deadline", () => {
  withGitRepo((repo) => {
    const result = repoSearch(repo, "retry backoff helper", {
      timeoutMs: 5_000,
      maxResults: 5,
      expiresAt: Date.now() - 1,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.results, []);
  });
});
