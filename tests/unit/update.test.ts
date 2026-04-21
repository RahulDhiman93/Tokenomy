import { test } from "node:test";
import assert from "node:assert/strict";
import { isDevSymlink, runUpdate } from "../../src/cli/update.js";

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
