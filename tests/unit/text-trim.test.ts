import { test } from "node:test";
import assert from "node:assert/strict";
import { headTailTrim, utf8Bytes } from "../../src/rules/text-trim.js";

test("headTailTrim: passthrough when within budget", () => {
  const s = "abcdef";
  assert.equal(headTailTrim(s, 100, 100), s);
});

test("headTailTrim: head + tail + elided marker", () => {
  const s = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"; // 26 bytes
  const out = headTailTrim(s, 5, 5);
  assert.ok(out.startsWith("ABCDE"));
  assert.ok(out.endsWith("VWXYZ"));
  assert.match(out, /\[tokenomy: elided \d+ bytes\]/);
});

test("utf8Bytes: counts multi-byte chars correctly", () => {
  assert.equal(utf8Bytes("a"), 1);
  assert.equal(utf8Bytes("é"), 2);
  assert.equal(utf8Bytes("🚀"), 4);
});

test("headTailTrim: does not split multi-byte chars (no replacement chars)", () => {
  const s = "ééééééééééééééééééééé"; // 42 bytes, 21 chars
  const out = headTailTrim(s, 5, 5);
  assert.ok(!out.includes("\uFFFD"));
});
