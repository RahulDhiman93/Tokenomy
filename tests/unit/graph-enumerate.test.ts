import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { enumerateGraphFiles } from "../../src/graph/enumerate.js";

test("graph enumerate: git mode respects .gitignore and filters TS/JS files", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-graph-enum-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(dir, "src", "keep.ts"), "export const keep = true;\n");
    writeFileSync(join(dir, "ignored.ts"), "export const ignored = true;\n");
    writeFileSync(join(dir, "notes.txt"), "ignore me\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const result = enumerateGraphFiles(dir, DEFAULT_CONFIG);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.files, ["src/keep.ts"]);
    assert.equal(result.source, "git");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graph enumerate: hard cap fails cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-graph-enum-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(dir, "src", `f${i}.ts`), `export const f${i} = ${i};\n`);
    }
    const result = enumerateGraphFiles(dir, {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, hard_max_files: 3 },
    });
    assert.deepEqual(result, { ok: false, reason: "repo-too-large" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
