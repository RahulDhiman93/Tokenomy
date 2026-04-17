import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpecifier } from "../../src/graph/resolve.js";

const FILES = new Set([
  "src/foo.ts",
  "src/bar/index.ts",
  "src/absolute.ts",
  "src/dep.js",
]);

test("graph resolve: relative specifier probes extensions", () => {
  assert.deepEqual(resolveSpecifier("src/main.ts", "./foo", FILES), {
    kind: "file",
    target: "src/foo.ts",
  });
});

test("graph resolve: absolute specifier stays inside repo", () => {
  assert.deepEqual(resolveSpecifier("src/main.ts", "/src/absolute.ts", FILES), {
    kind: "file",
    target: "src/absolute.ts",
  });
});

test("graph resolve: directory specifier probes index files", () => {
  assert.deepEqual(resolveSpecifier("src/main.ts", "./bar", FILES), {
    kind: "file",
    target: "src/bar/index.ts",
  });
});

test("graph resolve: bare and node built-ins become external modules", () => {
  assert.deepEqual(resolveSpecifier("src/main.ts", "react", FILES), {
    kind: "external-module",
    target: "react",
  });
  assert.deepEqual(resolveSpecifier("src/main.ts", "node:fs", FILES), {
    kind: "external-module",
    target: "node:fs",
  });
});

test("graph resolve: missing relative import returns best-guess file target", () => {
  const result = resolveSpecifier("src/main.ts", "./missing", FILES);
  assert.equal(result.kind, "missing-file");
  assert.equal(result.target, "src/missing.ts");
});

test("graph resolve: .js specifier maps to .ts source (TS NodeNext ESM)", () => {
  assert.deepEqual(resolveSpecifier("src/main.ts", "./foo.js", FILES), {
    kind: "file",
    target: "src/foo.ts",
  });
});

test("graph resolve: .jsx specifier maps to .tsx source", () => {
  const files = new Set(["src/Button.tsx"]);
  assert.deepEqual(resolveSpecifier("src/main.ts", "./Button.jsx", files), {
    kind: "file",
    target: "src/Button.tsx",
  });
});

test("graph resolve: .js specifier still resolves to literal .js when present", () => {
  // dep.js exists in FILES; the .ts fallback should not override a real .js match
  assert.deepEqual(resolveSpecifier("src/main.ts", "./dep.js", FILES), {
    kind: "file",
    target: "src/dep.js",
  });
});
