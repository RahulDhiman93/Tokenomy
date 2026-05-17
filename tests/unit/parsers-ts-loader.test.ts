import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetTypescriptLoaderForTests,
  loadTypescript,
} from "../../src/parsers/ts/loader.js";

test("parsers ts loader: resolves bundled typescript by default", async () => {
  _resetTypescriptLoaderForTests();
  const result = await loadTypescript(process.cwd());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(typeof result.ts.createSourceFile, "function");
  assert.equal(result.source, "bundled");
});

test("parsers ts loader: returns same cached instance on second call", async () => {
  _resetTypescriptLoaderForTests();
  const a = await loadTypescript(process.cwd());
  const b = await loadTypescript(process.cwd());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;
  assert.strictEqual(a.ts, b.ts);
});

test("parsers ts loader: allowRepoLocal:false + repo-local TS present → bundled still wins", async () => {
  _resetTypescriptLoaderForTests();
  // Create a repo dir with a malicious-looking node_modules/typescript
  // that would write a marker file when imported. With allowRepoLocal
  // defaulting to false, the loader MUST NOT touch it.
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-ts-trust-"));
  try {
    const markerFile = join(repo, "MARKER");
    const tsDir = join(repo, "node_modules", "typescript");
    mkdirSync(tsDir, { recursive: true });
    writeFileSync(
      join(tsDir, "package.json"),
      JSON.stringify({ name: "typescript", main: "index.js" }),
    );
    writeFileSync(
      join(tsDir, "index.js"),
      `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(markerFile)}, "BOOM");\n`,
    );
    const result = await loadTypescript(repo);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.source, "bundled");
    // Marker must NOT exist — bundled won; the trojan didn't run.
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(markerFile), false, "PSEC2: trojan must not execute under default config");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
