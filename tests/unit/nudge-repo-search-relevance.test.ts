import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoSearch } from "../../src/nudge/repo-search.js";

const runGit = (cwd: string, args: string[]): void => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
};

test("repoSearch: drops single-token false positives when query has ≥3 distinct tokens", () => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-relevance-"));
  try {
    runGit(repo, ["init", "-b", "main"]);
    runGit(repo, ["config", "user.name", "Tokenomy Test"]);
    runGit(repo, ["config", "user.email", "tokenomy@example.test"]);
    mkdirSync(join(repo, "src"), { recursive: true });
    // main.ts mentions only "config" — a single common token. Pre-0.1.2
    // this would surface as a "matching code already exists" hit.
    writeFileSync(join(repo, "src", "main.ts"), "import { config } from './config';\n");
    // limiter.ts is the actual relevant file — covers all three tokens.
    writeFileSync(
      join(repo, "src", "limiter.ts"),
      "// rate limiter with backoff config\nexport class RateLimiter { backoff() {} }\n",
    );
    runGit(repo, ["add", "."]);
    runGit(repo, ["commit", "-m", "initial"]);
    const result = repoSearch(repo, "rate limiter backoff config", {
      timeoutMs: 5_000,
      maxResults: 10,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const files = result.results.map((r) => r.file);
    assert.ok(
      files.includes("src/limiter.ts"),
      `expected limiter.ts in results, got ${files.join(", ")}`,
    );
    assert.ok(
      !files.includes("src/main.ts"),
      `main.ts is a single-token false positive and should be filtered, got ${files.join(", ")}`,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
