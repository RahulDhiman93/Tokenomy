import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sha256String } from "../../src/graph/hash.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";

test("graph repo id: uses git root when cwd is nested", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-repo-id-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
    const result = resolveRepoId(join(dir, "nested", "deeper"));
    const canonical = realpathSync(dir);
    assert.equal(result.repoPath, canonical);
    assert.equal(result.repoId, sha256String(canonical));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graph repo id: falls back to cwd outside git", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-repo-id-"));
  try {
    const result = resolveRepoId(dir);
    assert.equal(result.repoPath, resolve(dir));
    assert.equal(result.repoId, sha256String(resolve(dir)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
