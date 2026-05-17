import { test } from "node:test";
import assert from "node:assert/strict";
import { isWindowsReservedName } from "../../src/util/win-reserved.js";

test("isWindowsReservedName: bare reserved names", () => {
  for (const name of ["CON", "PRN", "AUX", "NUL", "COM1", "COM9", "LPT1", "LPT9"]) {
    assert.equal(isWindowsReservedName(name), true, name);
  }
});

test("isWindowsReservedName: reserved + extension", () => {
  for (const name of ["con.ts", "PRN.json", "nul.txt", "com1.cfg", "LPT3.md"]) {
    assert.equal(isWindowsReservedName(name), true, name);
  }
});

test("isWindowsReservedName: case-insensitive", () => {
  assert.equal(isWindowsReservedName("con"), true);
  assert.equal(isWindowsReservedName("Con"), true);
  assert.equal(isWindowsReservedName("cOn.TS"), true);
});

test("isWindowsReservedName: legitimate names that contain reserved substrings", () => {
  for (const name of ["console.ts", "ICON.png", "lpt10.json", "com10.ts", "conman.tsx"]) {
    assert.equal(isWindowsReservedName(name), false, name);
  }
});

test("isWindowsReservedName: multi-dot extensions don't match", () => {
  // Reserved names + ANY single-segment extension match (Windows treats
  // `con.anything` as the console device). Compound extensions like
  // `con.test.ts` (two dots after the reserved word) don't — that's a
  // file whose basename happens to start with the reserved word but is
  // a perfectly legal filename on Windows.
  assert.equal(isWindowsReservedName("con.test.ts"), false);
  // Single-extension forms remain reserved.
  assert.equal(isWindowsReservedName("con.test"), true);
});

test("isWindowsReservedName: empty + edge cases", () => {
  assert.equal(isWindowsReservedName(""), false);
  assert.equal(isWindowsReservedName("COM0"), false); // only COM1-9 reserved
  assert.equal(isWindowsReservedName("LPT0"), false);
});
