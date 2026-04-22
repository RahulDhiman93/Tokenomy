import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  _resetQueryCacheForTests,
  dispatchGraphTool,
} from "../../src/mcp/handlers.js";

interface FakeNpmSetup {
  stdout: string;
  status: number;
}

const withFakeNpm = async <T>(
  setup: FakeNpmSetup,
  fn: (repo: string, home: string) => Promise<T>,
): Promise<T> => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-oss-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-oss-repo-"));
  const bin = mkdtempSync(join(tmpdir(), "tokenomy-oss-bin-"));
  const originalPath = process.env["PATH"];
  const originalHome = process.env["HOME"];
  try {
    const npmPath = join(bin, "npm");
    const npmScript = `#!/bin/sh\ncat <<'JSON'\n${setup.stdout}\nJSON\nexit ${setup.status}\n`;
    writeFileSync(npmPath, npmScript);
    chmodSync(npmPath, 0o755);
    process.env["PATH"] = `${bin}${delimiter}${originalPath ?? ""}`;
    process.env["HOME"] = home;
    _resetQueryCacheForTests();
    return await fn(repo, home);
  } finally {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    if (originalHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = originalHome;
    _resetQueryCacheForTests();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
};

const makeEntry = (name: string, searchScore: number, final = 0.8): Record<string, unknown> => ({
  package: {
    name,
    version: "1.0.0",
    description: `Package ${name} for retries and backoff`.repeat(4),
    links: { npm: `https://www.npmjs.com/package/${name}` },
  },
  score: {
    final,
    detail: { quality: 0.8, popularity: 0.7, maintenance: 0.9 },
  },
  searchScore,
});

test("find_oss_alternatives: dispatchGraphTool returns query, results, summary, and hint", async () => {
  const entries = JSON.stringify([
    makeEntry("p-retry", 0.9, 0.9),
    makeEntry("async-retry", 0.6, 0.7),
  ]);

  await withFakeNpm({ stdout: entries, status: 0 }, async (repo) => {
    const result = (await dispatchGraphTool(
      "find_oss_alternatives",
      {
        description: "retry failed promises",
        keywords: ["backoff"],
        max_results: 5,
      },
      repo,
    )) as {
      ok: boolean;
      data?: {
        query: string;
        repo_results: unknown[];
        results: Array<{ name: string }>;
        summary: string;
        hint: string;
      };
    };

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data?.query, "retry failed promises backoff");
    assert.deepEqual(result.data?.repo_results, []);
    assert.deepEqual(result.data?.results.map((entry) => entry.name), [
      "p-retry",
      "async-retry",
    ]);
    assert.match(result.data?.summary ?? "", /Found 2 package candidates/);
    assert.match(result.data?.hint ?? "", /Present these package candidates/);
  });
});

test("find_oss_alternatives: includes local repo matches", async () => {
  await withFakeNpm({ stdout: "[]", status: 0 }, async (repo) => {
    // repo-search uses `git grep` on the working tree — needs a real git repo.
    const git = (args: string[]) =>
      spawnSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
    git(["init", "-q"]);
    git(["config", "user.email", "tokenomy@example.test"]);
    git(["config", "user.name", "Tokenomy Test"]);

    mkdirSync(join(repo, "src", "utils"), { recursive: true });
    writeFileSync(
      join(repo, "src", "utils", "retry.ts"),
      "export function retryBackoff() { return 'retry backoff helper'; }\n",
    );
    git(["add", "."]);
    git(["commit", "-q", "-m", "seed"]);

    const result = (await dispatchGraphTool(
      "find_oss_alternatives",
      { description: "retry backoff helper", max_results: 5 },
      repo,
    )) as {
      ok: boolean;
      data?: {
        repo_results: Array<{ source: string; file: string }>;
        results: unknown[];
        summary: string;
        hint: string;
      };
    };

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data?.results.length, 0);
    assert.deepEqual(result.data?.repo_results.map((entry) => entry.file), [
      "src/utils/retry.ts",
    ]);
    assert.equal(result.data?.repo_results[0]?.source, "current-branch");
    assert.match(result.data?.summary ?? "", /repo match/);
    assert.match(result.data?.hint ?? "", /Review repo matches first/);
  });
});

test("find_oss_alternatives: response budget clips large fake npm results", async () => {
  const entries = JSON.stringify(
    Array.from({ length: 10 }, (_, index) =>
      makeEntry(`retry-${index}`, 1 - index * 0.02, 0.9),
    ),
  );

  await withFakeNpm({ stdout: entries, status: 0 }, async (repo, home) => {
    mkdirSync(join(home, ".tokenomy"), { recursive: true });
    writeFileSync(
      join(home, ".tokenomy", "config.json"),
      JSON.stringify({
        graph: {
          query_budget_bytes: {
            find_oss_alternatives: 256,
          },
        },
      }),
    );

    const result = (await dispatchGraphTool(
      "find_oss_alternatives",
      { description: "retry helper", max_results: 10 },
      repo,
    )) as {
      ok: boolean;
      data?: { results: unknown[] };
      truncated?: { dropped_count: number };
    };

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.truncated, "expected budget clipping metadata");
    assert.ok(result.truncated!.dropped_count > 0);
    assert.ok((result.data?.results.length ?? 0) < 10);
  });
});
