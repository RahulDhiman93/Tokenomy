import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, isDevSymlink, runUpdate } from "../../src/cli/update.js";

const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "dist/cli/entry.js");

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

test("CLI: bare --version on `update` rejected, not silently defaulted", () => {
  // Spawn the built CLI so the parseArgs → entry-level guard is exercised
  // end-to-end. The guard must fire BEFORE the update branch triggers any
  // npm install, so exit=1 and stderr names the required arg.
  const r = spawnSync(process.execPath, [CLI, "update", "--version"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--version requires a value/);
});

test("CLI: bare --tag on `update` rejected, not silently defaulted", () => {
  const r = spawnSync(process.execPath, [CLI, "update", "--tag"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--tag requires a value/);
});

test("compareVersions: build metadata ignored (semver §10)", () => {
  assert.equal(compareVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(compareVersions("0.1.0-alpha.1+sha.abc", "0.1.0-alpha.1+sha.def"), 0);
});

// Check-mode runs the registry query against `target` (the pinned version
// when set, else the tag). We can't verify the stdout of runUpdate without
// stubbing npm; but we CAN assert that the target selection is surfaced
// in the suggested-command hint. Exercise the pinned path directly by
// capturing stdout while runUpdate's `fetchRegistryVersion` is shimmed.
//
// Rather than build a full spawn stub, we cover the wiring with a manual
// end-to-end smoke in the PR body:
//   $ tokenomy update --check --version=0.1.0-alpha.12
//   pin 0.1.0-alpha.12: 0.1.0-alpha.12
//   ✓ Installed is newer than the pinned target.
// Adding a unit test would require DI-injecting fetchRegistryVersion, and
// the indirection isn't worth it for a single-branch wiring check.
