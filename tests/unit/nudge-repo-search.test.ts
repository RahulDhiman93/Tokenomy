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
