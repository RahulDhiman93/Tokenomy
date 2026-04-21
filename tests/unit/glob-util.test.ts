import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAnyGlob, compileGlobs, matchesAny } from "../../src/util/glob.js";

test("matcher: ** matches any directory depth", () => {
  assert.equal(matchesAnyGlob("public/cdn/x.js", ["public/**"]), true);
  assert.equal(matchesAnyGlob("a/b/c/d/e.ts", ["**"]), true);
});

test("matcher: ** anchors and does not match siblings of prefix", () => {
  assert.equal(matchesAnyGlob("src/public.ts", ["public/**"]), false);
  assert.equal(matchesAnyGlob("not-public/x.ts", ["public/**"]), false);
});

test("matcher: **/ is zero-or-more segments — matches root files too", () => {
  assert.equal(matchesAnyGlob("foo.bundle.js", ["**/*.bundle.js"]), true);
  assert.equal(matchesAnyGlob("a/b/foo.bundle.js", ["**/*.bundle.js"]), true);
  assert.equal(matchesAnyGlob("foo.bundle.ts", ["**/*.bundle.js"]), false);
});

test("matcher: single * does not cross segment boundaries", () => {
  assert.equal(matchesAnyGlob("foo/bar.ts", ["foo/*"]), true);
  assert.equal(matchesAnyGlob("foo/bar/baz.ts", ["foo/*"]), false);
  assert.equal(matchesAnyGlob("bar.ts", ["*.ts"]), true);
  assert.equal(matchesAnyGlob("src/bar.ts", ["*.ts"]), false);
});

test("matcher: ? is a single non-slash char", () => {
  assert.equal(matchesAnyGlob("a.ts", ["?.ts"]), true);
  assert.equal(matchesAnyGlob("ab.ts", ["?.ts"]), false);
  assert.equal(matchesAnyGlob("a/b.ts", ["?/?.ts"]), true);
  assert.equal(matchesAnyGlob("ab/c.ts", ["?/?.ts"]), false);
});

test("matcher: regex metachars in literal text are escaped", () => {
  assert.equal(matchesAnyGlob("a.b.c", ["a.b.c"]), true);
  assert.equal(matchesAnyGlob("aXbXc", ["a.b.c"]), false);
  assert.equal(matchesAnyGlob("a+b", ["a+b"]), true);
  assert.equal(matchesAnyGlob("aab", ["a+b"]), false);
});

test("matcher: empty pattern list never matches", () => {
  assert.equal(matchesAnyGlob("anything.ts", []), false);
});

test("matcher: compileGlobs + matchesAny reuse precompiled regexes", () => {
  const compiled = compileGlobs(["**/*.min.js", "public/**"]);
  assert.equal(matchesAny("a/b.min.js", compiled), true);
  assert.equal(matchesAny("public/x.ts", compiled), true);
  assert.equal(matchesAny("src/x.ts", compiled), false);
});

test("matcher: default tokenomy bundle/minified patterns match realistic paths", () => {
  const defaults = [
    "**/*.min.js",
    "**/*.min.cjs",
    "**/*.min.mjs",
    "**/*-min.js",
    "**/*-min.cjs",
    "**/*-min.mjs",
    "**/*.bundle.js",
    "**/*.bundle.cjs",
    "**/*.bundle.mjs",
    "**/*-bundle.js",
    "**/*-bundle.cjs",
    "**/*-bundle.mjs",
  ];
  const compiled = compileGlobs(defaults);
  // Dot convention
  assert.equal(matchesAny("vendor/jquery.min.js", compiled), true);
  assert.equal(matchesAny("app.bundle.cjs", compiled), true);
  // Dash convention — the firebase-bundle.js case that triggered this feature
  assert.equal(matchesAny("public/cdn/firebase/firebase-bundle.js", compiled), true);
  assert.equal(matchesAny("app-min.mjs", compiled), true);
  // Real source files must NOT match
  assert.equal(matchesAny("src/foo.ts", compiled), false);
  assert.equal(matchesAny("src/foo.js", compiled), false);
  assert.equal(matchesAny("src/bundle-view.ts", compiled), false);
});
