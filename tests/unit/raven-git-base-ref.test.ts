import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGitState, resolveBaseRef } from "../../src/raven/git.js";

const runGit = (cwd: string, args: string[]): void => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(
    r.status,
    0,
    `git ${args.join(" ")} failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
  );
};

const initRepoOnFeatureBranch = (): { repo: string; cleanup: () => void } => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-raven-base-"));
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.name", "Tokenomy Test"]);
  runGit(repo, ["config", "user.email", "tokenomy@example.test"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "base.ts"), "export const base = 1;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "initial on main"]);
  // Feature branch with two committed-only files. Working tree clean → the
  // pre-beta.6 collectGitState would return changed_files = [].
  runGit(repo, ["checkout", "-b", "feature/x"]);
  writeFileSync(join(repo, "src", "feature-a.ts"), "export const featureA = 1;\n");
  writeFileSync(join(repo, "src", "feature-b.ts"), "export const featureB = 2;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "add feature files"]);
  return { repo, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
};

test("collectGitState: committed-only feature branch surfaces files via base ref", () => {
  const { repo, cleanup } = initRepoOnFeatureBranch();
  try {
    const result = collectGitState(repo);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data.dirty, false, "working tree clean");
    assert.equal(result.data.base_ref, "main");
    assert.deepEqual(result.data.committed_files, ["src/feature-a.ts", "src/feature-b.ts"]);
    assert.deepEqual(result.data.changed_files, ["src/feature-a.ts", "src/feature-b.ts"]);
    assert.ok(
      result.data.stats.some((s) => s.file === "src/feature-a.ts" && s.additions >= 1),
      `expected numstat to include feature-a.ts: ${JSON.stringify(result.data.stats)}`,
    );
  } finally {
    cleanup();
  }
});

test("collectGitState: working-tree changes plus committed changes both surface", () => {
  const { repo, cleanup } = initRepoOnFeatureBranch();
  try {
    writeFileSync(join(repo, "src", "uncommitted.ts"), "export const u = 1;\n");
    const result = collectGitState(repo);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.data.dirty, true);
    assert.deepEqual(result.data.untracked_files, ["src/uncommitted.ts"]);
    assert.deepEqual(result.data.committed_files, ["src/feature-a.ts", "src/feature-b.ts"]);
    assert.deepEqual(result.data.changed_files, [
      "src/feature-a.ts",
      "src/feature-b.ts",
      "src/uncommitted.ts",
    ]);
  } finally {
    cleanup();
  }
});

test("resolveBaseRef: prefers RAVEN_BASE_REF env when set", () => {
  const { repo, cleanup } = initRepoOnFeatureBranch();
  const prev = process.env["RAVEN_BASE_REF"];
  try {
    runGit(repo, ["branch", "develop"]);
    process.env["RAVEN_BASE_REF"] = "develop";
    assert.equal(resolveBaseRef(repo, "feature/x"), "develop");
  } finally {
    if (prev === undefined) delete process.env["RAVEN_BASE_REF"];
    else process.env["RAVEN_BASE_REF"] = prev;
    cleanup();
  }
});

test("resolveBaseRef: returns null when on the trunk branch", () => {
  const { repo, cleanup } = initRepoOnFeatureBranch();
  try {
    runGit(repo, ["checkout", "main"]);
    // No remote, no master, current = main → no candidate left.
    assert.equal(resolveBaseRef(repo, "main"), null);
  } finally {
    cleanup();
  }
});
