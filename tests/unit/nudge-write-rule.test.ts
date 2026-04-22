import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { writeNudgeRule } from "../../src/rules/write-nudge.js";
import type { Config } from "../../src/core/types.js";

const withTmpRepo = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-write-nudge-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const largeContent = "x".repeat(1_200);
const tinyContent = "x".repeat(100);

test("write-nudge: fires for NEW file in src/utils with sufficient size", () => {
  withTmpRepo((dir) => {
    const r = writeNudgeRule(
      { file_path: "src/utils/retry.ts", content: largeContent },
      DEFAULT_CONFIG,
      dir,
    );
    assert.equal(r.kind, "nudge");
    assert.ok(
      r.additionalContext?.includes("src/utils/retry.ts"),
      `hint should mention the path; got ${r.additionalContext}`,
    );
    assert.ok(
      r.additionalContext?.includes("find_oss_alternatives"),
      "hint should point at the MCP tool",
    );
    assert.ok(
      r.additionalContext?.includes("nudge.write_intercept.enabled"),
      "hint should include disable command",
    );
  });
});

test("write-nudge: passthrough for files under size threshold", () => {
  withTmpRepo((dir) => {
    const r = writeNudgeRule(
      { file_path: "src/utils/tiny.ts", content: tinyContent },
      DEFAULT_CONFIG,
      dir,
    );
    assert.equal(r.kind, "passthrough");
  });
});

test("write-nudge: passthrough for overwrite of existing file", () => {
  withTmpRepo((dir) => {
    const existing = join(dir, "src-utils-existing.ts");
    writeFileSync(existing, "existing content");
    const r = writeNudgeRule(
      { file_path: existing, content: largeContent },
      DEFAULT_CONFIG,
      dir,
    );
    assert.equal(r.kind, "passthrough");
  });
});

test("write-nudge: passthrough for path not matching any trigger glob", () => {
  withTmpRepo((dir) => {
    const r = writeNudgeRule(
      { file_path: "tests/unit/foo.test.ts", content: largeContent },
      DEFAULT_CONFIG,
      dir,
    );
    assert.equal(r.kind, "passthrough");
  });
});

test("write-nudge: master switch nudge.enabled=false silences everything", () => {
  withTmpRepo((dir) => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      nudge: { ...DEFAULT_CONFIG.nudge!, enabled: false },
    };
    const r = writeNudgeRule(
      { file_path: "src/utils/retry.ts", content: largeContent },
      cfg,
      dir,
    );
    assert.equal(r.kind, "passthrough");
  });
});

test("write-nudge: write_intercept.enabled=false silences the write path but leaves master on", () => {
  withTmpRepo((dir) => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      nudge: {
        ...DEFAULT_CONFIG.nudge!,
        write_intercept: { ...DEFAULT_CONFIG.nudge!.write_intercept, enabled: false },
      },
    };
    const r = writeNudgeRule(
      { file_path: "src/utils/retry.ts", content: largeContent },
      cfg,
      dir,
    );
    assert.equal(r.kind, "passthrough");
  });
});

test("write-nudge: absolute file_path under cwd still matches globs", () => {
  withTmpRepo((dir) => {
    const abs = join(dir, "src/lib/http-client.ts");
    const r = writeNudgeRule(
      { file_path: abs, content: largeContent },
      DEFAULT_CONFIG,
      dir,
    );
    assert.equal(r.kind, "nudge");
    assert.ok(r.additionalContext?.includes("src/lib/http-client.ts"));
  });
});

test("write-nudge: paths escaping repo root are rejected", () => {
  withTmpRepo((dir) => {
    // Absolute path OUTSIDE cwd → the computed `rel` starts with "../".
    const outside = "/tmp/tokenomy-outside/src/utils/foo.ts";
    const r = writeNudgeRule(
      { file_path: outside, content: largeContent },
      DEFAULT_CONFIG,
      dir,
    );
    assert.equal(r.kind, "passthrough");
  });
});

test("write-nudge: custom paths config replaces the default list", () => {
  withTmpRepo((dir) => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      nudge: {
        ...DEFAULT_CONFIG.nudge!,
        write_intercept: {
          ...DEFAULT_CONFIG.nudge!.write_intercept,
          paths: ["packages/my-pkg/**"],
        },
      },
    };
    // Default glob matches but custom doesn't.
    const defaultPath = writeNudgeRule(
      { file_path: "src/utils/foo.ts", content: largeContent },
      cfg,
      dir,
    );
    assert.equal(defaultPath.kind, "passthrough");
    // Custom glob matches.
    const customPath = writeNudgeRule(
      { file_path: "packages/my-pkg/foo.ts", content: largeContent },
      cfg,
      dir,
    );
    assert.equal(customPath.kind, "nudge");
  });
});

test("write-nudge: non-string content passes through", () => {
  withTmpRepo((dir) => {
    const r = writeNudgeRule(
      { file_path: "src/utils/foo.ts", content: 42 as unknown as string },
      DEFAULT_CONFIG,
      dir,
    );
    assert.equal(r.kind, "passthrough");
  });
});
