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

test("isWindowsReservedName: multi-dot extensions still match (codex round 6 P2)", () => {
  // Reserved names + ANY tail starting with `.` is treated as the
  // device path on Windows — the reserved word is the portion
  // before the FIRST dot. Pre-fix the regex allowed only one
  // extension segment, letting compound names through.
  assert.equal(isWindowsReservedName("con.test.ts"), true);
  assert.equal(isWindowsReservedName("NUL.spec.tsx"), true);
  assert.equal(isWindowsReservedName("LPT1.foo.bar.js"), true);
  // Single-extension forms remain reserved.
  assert.equal(isWindowsReservedName("con.test"), true);
});

test("isWindowsReservedName: empty + edge cases", () => {
  assert.equal(isWindowsReservedName(""), false);
  assert.equal(isWindowsReservedName("COM0"), false); // only COM1-9 reserved
  assert.equal(isWindowsReservedName("LPT0"), false);
});
