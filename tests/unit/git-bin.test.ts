import { test } from "node:test";
import assert from "node:assert/strict";
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

test("getVerifiedGitBin: GIT_EXEC_PATH override is trusted verbatim", () => {
  _resetGitBinForTests();
  withEnv("GIT_EXEC_PATH", "/opt/custom/git", () => {
    assert.equal(getVerifiedGitBin(), "/opt/custom/git");
  });
});

test("getVerifiedGitBin: cached across calls", () => {
  _resetGitBinForTests();
  withEnv("GIT_EXEC_PATH", "/opt/cached/git", () => {
    const a = getVerifiedGitBin();
    const b = getVerifiedGitBin();
    assert.equal(a, b);
  });
});

test("getVerifiedGitBin: on system with real git, returns absolute path or null", () => {
  _resetGitBinForTests();
  withEnv("GIT_EXEC_PATH", undefined, () => {
    const out = getVerifiedGitBin();
    // Either we got a safe-prefix path, or null (with a stderr warn);
    // both are valid outcomes depending on the host's git layout.
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
});

test("_resetGitBinForTests: clears cache between cases", () => {
  _resetGitBinForTests();
  withEnv("GIT_EXEC_PATH", "/path/a", () => {
    assert.equal(getVerifiedGitBin(), "/path/a");
  });
  _resetGitBinForTests();
  withEnv("GIT_EXEC_PATH", "/path/b", () => {
    assert.equal(getVerifiedGitBin(), "/path/b");
  });
});
