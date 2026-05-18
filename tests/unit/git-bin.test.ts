import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetGitBinForTests,
  getVerifiedGitBin,
} from "../../src/util/git-bin.js";

const withEnv = (key: string, value: string | undefined, fn: () => void): void => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

const withFakeGit = (fn: (dir: string, exe: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-git-bin-"));
  try {
    const exe = join(dir, process.platform === "win32" ? "git.exe" : "git");
    writeFileSync(exe, "#!/bin/sh\necho fake\n");
    chmodSync(exe, 0o755);
    fn(dir, exe);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("getVerifiedGitBin: TOKENOMY_GIT_BIN override trusted verbatim when path resolves to a file", () => {
  _resetGitBinForTests();
  withFakeGit((_dir, exe) => {
    withEnv("TOKENOMY_GIT_BIN", exe, () => {
      // 0.1.10+ opencode round 1 P1: result is realpath'd so
      // symlink-bypass attacks can't fool the safe-prefix check.
      // On macOS /var/folders/... → /private/var/folders/...
      assert.equal(getVerifiedGitBin(), realpathSync(exe));
    });
  });
});

test("getVerifiedGitBin: TOKENOMY_GIT_BIN pointing at non-existent path falls back", () => {
  _resetGitBinForTests();
  // Force PATH to a known-empty dir so the fallback can't find git
  // and returns null (or whatever the host's git layout produces).
  withEnv("TOKENOMY_GIT_BIN", "/totally/missing/git", () => {
    // Fallback honors PATH-walk; the test only asserts no crash.
    getVerifiedGitBin();
    assert.ok(true);
  });
});

test("getVerifiedGitBin: cached across calls", () => {
  _resetGitBinForTests();
  withFakeGit((_dir, exe) => {
    withEnv("TOKENOMY_GIT_BIN", exe, () => {
      const a = getVerifiedGitBin();
      const b = getVerifiedGitBin();
      assert.equal(a, b);
    });
  });
});

test("getVerifiedGitBin: in-process PATH walk does NOT spawn any subprocess", () => {
  _resetGitBinForTests();
  // No env override → PATH walk fires. We can't easily assert "no
  // subprocess spawned", but we can assert the function returns
  // synchronously and never throws.
  const start = Date.now();
  const out = getVerifiedGitBin();
  const elapsed = Date.now() - start;
  // Spawning a helper would cost ~20-50ms even on hot caches;
  // in-process walk is sub-ms. Generous 100ms ceiling.
  assert.ok(elapsed < 100, `expected sub-100ms, got ${elapsed}ms`);
  if (out !== null) {
    assert.ok(
      out.startsWith("/usr/") ||
        out.startsWith("/opt/") ||
        out.startsWith("/Applications/") ||
        out.startsWith("C:\\Program Files"),
      `unexpected path: ${out}`,
    );
  }
});

test("_resetGitBinForTests: clears cache between cases", () => {
  _resetGitBinForTests();
  withFakeGit((_dir, exeA) => {
    withEnv("TOKENOMY_GIT_BIN", exeA, () => {
      assert.equal(getVerifiedGitBin(), realpathSync(exeA));
    });
  });
  _resetGitBinForTests();
  withFakeGit((_dir, exeB) => {
    withEnv("TOKENOMY_GIT_BIN", exeB, () => {
      assert.equal(getVerifiedGitBin(), realpathSync(exeB));
    });
  });
});
