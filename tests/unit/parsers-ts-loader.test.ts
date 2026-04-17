import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTypescript } from "../../src/parsers/ts/loader.js";

test("parsers ts loader: resolves installed typescript", async () => {
  const result = await loadTypescript(process.cwd());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(typeof result.ts.createSourceFile, "function");
});

test("parsers ts loader: missing typescript branch returns structured error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-ts-missing-"));
  try {
    const result = await loadTypescript(dir, { allowProcessResolver: false });
    assert.deepEqual(result, {
      ok: false,
      reason: "typescript-not-installed",
      hint:
        "Install `typescript` in the target repo or alongside Tokenomy, then re-run `tokenomy graph build`.",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
