import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isDevSymlink, runUpdate } from "../../src/cli/update.js";

// These tests focus on the pieces that are safe to run without network:
// arg-parsing + dev-symlink guard. The actual npm-install spawn is covered
// only by the manual smoke command documented in the PR body.

test("runUpdate: dev-symlink guard blocks install without --force", async () => {
  // Stub stderr so the test output stays clean.
  const originalWrite = process.stderr.write.bind(process.stderr);
  const captured: string[] = [];
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    captured.push(s);
    return true;
  };
  try {
    // tsx runs the source from the repo, which IS a dev symlink once
    // `npm link` has been done. In CI (no link) this returns false and
    // the test skips with a note — best effort.
    if (!isDevSymlink()) {
      // Skip: guard can't trip without a dev link present.
      return;
    }
    const code = await runUpdate({ check: false });
    assert.equal(code, 1);
    assert.ok(
      captured.some((s) => /dev checkout|npm link/.test(s)),
      `expected a dev-symlink warning, got: ${captured.join("")}`,
    );
  } finally {
    (process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
  }
});

test("isDevSymlink: returns a boolean without throwing", () => {
  const v = isDevSymlink();
  assert.equal(typeof v, "boolean");
});

// Check-mode network calls are intentionally NOT tested here — we don't
// want unit tests reaching out to the npm registry. A follow-up could
// inject a fake fetch via DI; for now the manual smoke covers it.

test("compareVersions: numeric suffix ordering", () => {
  // The case the original numeric-only impl got right.
  assert.ok(compareVersions("0.1.0-alpha.12", "0.1.0-alpha.3") > 0);
  assert.ok(compareVersions("0.1.0-alpha.3", "0.1.0-alpha.12") < 0);
  assert.equal(compareVersions("0.1.0-alpha.12", "0.1.0-alpha.12"), 0);
});

test("compareVersions: prerelease label precedence (alpha < beta < rc)", () => {
  // The case Codex flagged — previously all three collapsed to numeric
  // comparison so the labels were lost and alpha.13 > beta.1 was wrong.
  assert.ok(compareVersions("0.1.0-alpha.13", "0.1.0-beta.1") < 0, "alpha.13 < beta.1");
  assert.ok(compareVersions("0.1.0-beta.1", "0.1.0-rc.1") < 0, "beta.1 < rc.1");
  assert.ok(compareVersions("0.1.0-rc.1", "0.1.0-alpha.99") > 0, "rc.1 > alpha.99");
});

test("compareVersions: no-prerelease beats any prerelease on same main", () => {
  assert.ok(compareVersions("0.1.0", "0.1.0-alpha.1") > 0);
  assert.ok(compareVersions("0.1.0", "0.1.0-rc.99") > 0);
  assert.ok(compareVersions("0.1.0-rc.99", "0.1.0") < 0);
});

test("compareVersions: main version trumps prerelease", () => {
  assert.ok(compareVersions("0.2.0-alpha.1", "0.1.0") > 0);
  assert.ok(compareVersions("1.0.0-alpha.1", "0.99.0") > 0);
});

test("compareVersions: numeric identifiers rank below alphanumeric ones", () => {
  // Per semver.org §11: "Numeric identifiers always have lower precedence
  // than alphanumeric identifiers."
  assert.ok(compareVersions("1.0.0-1", "1.0.0-alpha") < 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-1") > 0);
});

test("compareVersions: longer prerelease list wins when common prefix is equal", () => {
  assert.ok(compareVersions("1.0.0-alpha.1", "1.0.0-alpha") > 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0);
});

test("compareVersions: build metadata ignored (semver §10)", () => {
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(compareVersions("0.1.0-alpha.1+sha.abc", "0.1.0-alpha.1+sha.def"), 0);
});
