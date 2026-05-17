import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compileGlobs,
  GlobCompileError,
  globToPathRegex,
} from "../../src/util/glob.js";

test("globToPathRegex: normal patterns compile fine", () => {
  assert.ok(globToPathRegex("**/*.test.ts"));
  assert.ok(globToPathRegex("src/**/index.ts"));
  assert.ok(globToPathRegex("dist/**"));
});

test("globToPathRegex: rejects pattern longer than 256 chars", () => {
  const long = "a".repeat(257);
  assert.throws(() => globToPathRegex(long), (err: unknown) => {
    assert.ok(err instanceof GlobCompileError);
    return true;
  });
});

test("globToPathRegex: rejects more than 16 stars", () => {
  const many = "*".repeat(17);
  assert.throws(() => globToPathRegex(many), (err: unknown) => {
    assert.ok(err instanceof GlobCompileError);
    assert.match((err as GlobCompileError).message, /17 '\*' chars > 16/);
    return true;
  });
});

test("compileGlobs: pathological entry is skipped, valid neighbors compile", () => {
  const realWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
    captured += s;
    return true;
  };
  try {
    const compiled = compileGlobs([
      "src/**/*.ts",
      "*".repeat(20), // pathological
      "**/test/**",
    ]);
    assert.equal(compiled.length, 2);
    assert.match(captured, /glob ".*" rejected/);
  } finally {
    process.stderr.write = realWrite;
  }
});

test("compileGlobs: 16 stars exactly is accepted", () => {
  const exactly16 = "*".repeat(16);
  const compiled = compileGlobs([exactly16]);
  assert.equal(compiled.length, 1);
});
