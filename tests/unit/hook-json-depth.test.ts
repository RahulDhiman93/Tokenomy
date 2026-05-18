import { test } from "node:test";
import assert from "node:assert/strict";

// The depth-scan helper lives inside hook/entry.ts and isn't exported
// (entry.ts is the binary). Replicate the logic here to assert
// correctness; if the production copy drifts, this test stays as a
// contract for the algorithm shape.

const exceedsJsonDepth = (s: string, max: number): boolean => {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (c === 0x5c) escape = true;
      else if (c === 0x22) inStr = false;
      continue;
    }
    if (c === 0x22) {
      inStr = true;
    } else if (c === 0x7b || c === 0x5b) {
      depth++;
      if (depth > max) return true;
    } else if (c === 0x7d || c === 0x5d) {
      if (depth > 0) depth--;
    }
  }
  return false;
};

test("exceedsJsonDepth: shallow payload passes", () => {
  assert.equal(exceedsJsonDepth('{"a":1}', 64), false);
  assert.equal(exceedsJsonDepth("[1,2,3]", 64), false);
  assert.equal(exceedsJsonDepth('{"a":[{"b":2}]}', 64), false);
});

test("exceedsJsonDepth: depth equal to max passes", () => {
  let s = "";
  for (let i = 0; i < 64; i++) s += "[";
  s += "1";
  for (let i = 0; i < 64; i++) s += "]";
  assert.equal(exceedsJsonDepth(s, 64), false);
});

test("exceedsJsonDepth: depth one above max rejects", () => {
  let s = "";
  for (let i = 0; i < 65; i++) s += "[";
  s += "1";
  for (let i = 0; i < 65; i++) s += "]";
  assert.equal(exceedsJsonDepth(s, 64), true);
});

test("exceedsJsonDepth: 100k deep rejected", () => {
  const N = 100_000;
  const s = "[".repeat(N) + "1" + "]".repeat(N);
  assert.equal(exceedsJsonDepth(s, 64), true);
});

test("exceedsJsonDepth: braces inside strings don't count", () => {
  assert.equal(exceedsJsonDepth('{"a":"[[[[[]]]]]","b":1}', 5), false);
  assert.equal(exceedsJsonDepth('{"a":"\\"{{{{"}', 5), false);
});

test("exceedsJsonDepth: empty string passes", () => {
  assert.equal(exceedsJsonDepth("", 64), false);
});
