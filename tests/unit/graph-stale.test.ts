import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { sha256FileSync } from "../../src/graph/hash.js";
import { getGraphStaleStatus } from "../../src/graph/stale.js";
import type { GraphMeta } from "../../src/graph/schema.js";

const createMeta = (dir: string): GraphMeta => {
  const file = join(dir, "src", "a.ts");
  const st = statSync(file);
  return {
    schema_version: 1,
    repo_id: "repo",
    repo_path: dir,
    built_at: "2026-04-17T00:00:00.000Z",
    tokenomy_version: "0.1.0-alpha.4",
    node_count: 1,
    edge_count: 0,
    file_hashes: { "src/a.ts": sha256FileSync(file) },
    file_mtimes: { "src/a.ts": st.mtimeMs },
    soft_cap: 2_000,
    hard_cap: 5_000,
    parse_error_count: 0,
  };
};

test("graph stale: mtime change with same content is not stale; content change is stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-graph-stale-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    const meta = createMeta(dir);

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    const sameContent = getGraphStaleStatus(dir, meta, DEFAULT_CONFIG);
    assert.equal(sameContent.ok, true);
    if (!sameContent.ok) return;
    assert.equal(sameContent.stale, false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");
    const changed = getGraphStaleStatus(dir, meta, DEFAULT_CONFIG);
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    assert.equal(changed.stale, true);
    assert.deepEqual(changed.stale_files, ["src/a.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graph stale: added and removed files are surfaced", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-graph-stale-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    const meta = createMeta(dir);

    writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
    rmSync(join(dir, "src", "a.ts"));

    const status = getGraphStaleStatus(dir, meta, DEFAULT_CONFIG);
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.stale, true);
    assert.deepEqual(status.stale_files, ["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
