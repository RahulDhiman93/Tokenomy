import { test } from "node:test";
import assert from "node:assert/strict";
import { colorsEnabled } from "../../src/util/color.js";

const withEnv = (key: string, value: string | undefined, fn: () => void): void => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

const withTTY = (isTTY: boolean, fn: () => void): void => {
  const prev = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTTY,
    configurable: true,
  });
  try {
    fn();
  } finally {
    Object.defineProperty(process.stdout, "isTTY", {
      value: prev,
      configurable: true,
    });
  }
};

test("colorsEnabled: NO_COLOR env disables", () => {
  withEnv("NO_COLOR", "1", () => {
    withTTY(true, () => {
      assert.equal(colorsEnabled(), false);
    });
  });
});

test("colorsEnabled: NO_COLOR=\"\" still disables (presence matters, not value)", () => {
  withEnv("NO_COLOR", "", () => {
    withTTY(true, () => {
      assert.equal(colorsEnabled(), false);
    });
  });
});

test("colorsEnabled: non-TTY disables", () => {
  withEnv("NO_COLOR", undefined, () => {
    withTTY(false, () => {
      assert.equal(colorsEnabled(), false);
    });
  });
});

test("colorsEnabled: TTY + no NO_COLOR + no --no-color enables", () => {
  withEnv("NO_COLOR", undefined, () => {
    withTTY(true, () => {
      // We can't easily inject argv mid-test without affecting other
      // tests' module-init state; rely on the present argv lacking
      // --no-color.
      const hasFlag = process.argv.includes("--no-color");
      if (hasFlag) {
        assert.equal(colorsEnabled(), false);
      } else {
        assert.equal(colorsEnabled(), true);
      }
    });
  });
});
