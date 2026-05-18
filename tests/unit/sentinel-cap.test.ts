import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { markGraphDirty } from "../../src/rules/graph-dirty.js";
import { graphDir, graphDirtySentinelPath } from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { readDirtySentinel } from "../../src/graph/stale.js";

const withTmpRepo = (fn: (repoPath: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-sentcap-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-sentcap-repo-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    execSync("git init -q", { cwd: repo });
    execSync('git -c user.email=a@b.com -c user.name=a commit --allow-empty -q -m init', {
      cwd: repo,
    });
    fn(repo);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
};

test("sentinel cap: oversize file is rotated keeping newest entries deduped", () => {
  withTmpRepo((repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    // Seed: 20K lines, alternating two paths, lots of dups; total > 1MB
    const lines: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const path = i % 2 === 0 ? "src/a.ts" : "src/b.ts";
      lines.push(`2026-05-16T00:00:00.${String(i).padStart(3, "0")}Z\t${repo}/${path}`);
    }
    writeFileSync(sentinel, lines.join("\n") + "\n");
    const beforeSize = statSync(sentinel).size;
    assert.ok(beforeSize > 1_048_576, `expected >1MB before, got ${beforeSize}`);

    markGraphDirty(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: "x",
        tool_input: { file_path: join(repo, "src/new.ts") },
        cwd: repo,
        session_id: "s",
        transcript_path: "/tmp/x",
        tool_response: { content: [{ type: "text", text: "ok" }] },
      },
      DEFAULT_CONFIG,
    );

    const afterSize = statSync(sentinel).size;
    assert.ok(afterSize < beforeSize, `expected smaller after, got ${afterSize}`);
    // Parse and confirm dedup happened: should only see 3 unique paths
    const parsed = readDirtySentinel(sentinel, repo);
    assert.deepEqual(parsed.files.sort(), ["src/a.ts", "src/b.ts", "src/new.ts"]);
  });
});

test("sentinel cap: under cap → no rotation, simple append", () => {
  withTmpRepo((repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(sentinel, "2026-05-15T00:00:00.000Z\tsrc/x.ts\n");
    markGraphDirty(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_use_id: "x",
        tool_input: { file_path: join(repo, "src/y.ts") },
        cwd: repo,
        session_id: "s",
        transcript_path: "/tmp/x",
        tool_response: { content: [{ type: "text", text: "ok" }] },
      },
      DEFAULT_CONFIG,
    );
    const parsed = readDirtySentinel(sentinel, repo);
    assert.deepEqual(parsed.files, ["src/x.ts", "src/y.ts"]);
  });
});

test("drive-letter normalize: POSIX reader drops Windows absolute lines", () => {
  withTmpRepo((repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      sentinel,
      "2026-05-15T00:00:00.000Z\tC:\\repo\\src\\a.ts\n2026-05-15T00:00:01.000Z\tsrc/ok.ts\n",
    );
    const parsed = readDirtySentinel(sentinel, repo);
    // On POSIX, the drive-letter line is dropped; the relative line survives.
    assert.deepEqual(parsed.files, ["src/ok.ts"]);
  });
});

test("drive-letter normalize: lowercase drive letter also recognized", () => {
  withTmpRepo((repo) => {
    const identity = resolveRepoId(repo);
    mkdirSync(graphDir(identity, DEFAULT_CONFIG.graph), { recursive: true });
    const sentinel = graphDirtySentinelPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      sentinel,
      "2026-05-15T00:00:00.000Z\td:/work/foo.ts\n2026-05-15T00:00:01.000Z\tsrc/ok.ts\n",
    );
    const parsed = readDirtySentinel(sentinel, repo);
    assert.deepEqual(parsed.files, ["src/ok.ts"]);
  });
});
