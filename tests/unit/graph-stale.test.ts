import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { fingerprintExcludes } from "../../src/graph/exclude-fingerprint.js";
import { computeTsconfigFingerprint } from "../../src/graph/tsconfig-fingerprint.js";
import { sha256FileSync } from "../../src/graph/hash.js";
import { getGraphStaleStatus, isGraphStaleCheap } from "../../src/graph/stale.js";
import { buildGraph } from "../../src/graph/build.js";
import { enumerateAllFiles } from "../../src/graph/enumerate.js";
import type { GraphMeta } from "../../src/graph/schema.js";
import type { Config } from "../../src/core/types.js";

const createMeta = (dir: string): GraphMeta => {
  const file = join(dir, "src", "a.ts");
  const st = statSync(file);
  const raw = enumerateAllFiles(dir);
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
    exclude_fingerprint: fingerprintExcludes(DEFAULT_CONFIG.graph.exclude),
    tsconfig_fingerprint: computeTsconfigFingerprint(
      dir,
      raw.files,
      DEFAULT_CONFIG.graph.tsconfig.enabled,
    ),
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

// The MCP read-side auto-refresh path uses isGraphStaleCheap before every
// cacheable query. These tests validate each branch of the cheap helper.

const withTmpRepo = async <T>(fn: (dir: string) => T | Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-stale-cheap-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = mkdtempSync(join(tmpdir(), "tokenomy-home-"));
  try {
    return await fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
};

test("isGraphStaleCheap: returns missing when no graph has been built", async () => {
  await withTmpRepo((dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const result = isGraphStaleCheap(dir, DEFAULT_CONFIG);
    assert.equal(result.missing, true);
    assert.equal(result.stale, true);
    assert.deepEqual(result.stale_files, []);
  });
});

test("isGraphStaleCheap: missing snapshot (meta survives) is treated as missing", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const built = await buildGraph({ cwd: dir, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);

    const { graphSnapshotPath } = await import("../../src/core/paths.js");
    const { resolveRepoId } = await import("../../src/graph/repo-id.js");
    const { repoId } = resolveRepoId(dir);
    rmSync(graphSnapshotPath(repoId));

    const result = isGraphStaleCheap(dir, DEFAULT_CONFIG);
    assert.equal(result.missing, true);
    assert.equal(result.stale, true);
  });
});

test("isGraphStaleCheap: fresh graph → not stale, no files flagged", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const build = await buildGraph({ cwd: dir, config: DEFAULT_CONFIG });
    assert.equal(build.ok, true);

    const result = isGraphStaleCheap(dir, DEFAULT_CONFIG);
    assert.equal(result.missing, false);
    assert.equal(result.stale, false);
    assert.deepEqual(result.stale_files, []);
  });
});

test("isGraphStaleCheap: exclude-set change alone invalidates the graph", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const buildA = await buildGraph({ cwd: dir, config: DEFAULT_CONFIG });
    assert.equal(buildA.ok, true);

    const cfgB: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, exclude: ["vendor/**"] },
    };
    const result = isGraphStaleCheap(dir, cfgB);
    assert.equal(result.missing, false);
    assert.equal(result.stale, true);
    assert.deepEqual(result.stale_files, []);
  });
});

test("isGraphStaleCheap: mtime change surfaces the file in stale_files", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    await buildGraph({ cwd: dir, config: DEFAULT_CONFIG });

    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 2;\n");

    const result = isGraphStaleCheap(dir, DEFAULT_CONFIG);
    assert.equal(result.missing, false);
    assert.equal(result.stale, true);
    assert.deepEqual(result.stale_files, ["src/a.ts"]);
  });
});

test("isGraphStaleCheap: editing tsconfig paths invalidates the graph", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    await buildGraph({ cwd: dir, config: DEFAULT_CONFIG });

    // Edit paths — no source-file change, but resolution semantics changed.
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["src/*"] } },
      }),
    );

    const result = isGraphStaleCheap(dir, DEFAULT_CONFIG);
    assert.equal(result.missing, false);
    assert.equal(result.stale, true, "tsconfig paths edit must invalidate");
  });
});

test("isGraphStaleCheap: toggling graph.tsconfig.enabled invalidates the graph", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    // Build with resolver enabled (the default).
    await buildGraph({ cwd: dir, config: DEFAULT_CONFIG });

    // Flip to disabled — meta's fingerprint reflects enabled state, current
    // check uses disabled sentinel. Must mismatch → stale.
    const disabledCfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, tsconfig: { enabled: false } },
    };
    const result = isGraphStaleCheap(dir, disabledCfg);
    assert.equal(result.missing, false);
    assert.equal(result.stale, true, "disabling tsconfig must invalidate a graph built with it enabled");
  });
});

test("isGraphStaleCheap: pre-alpha.17 meta (no tsconfig_fingerprint) is stale", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    await buildGraph({ cwd: dir, config: DEFAULT_CONFIG });

    // Strip tsconfig_fingerprint from meta to simulate pre-alpha.17 state.
    const { graphMetaPath } = await import("../../src/core/paths.js");
    const { resolveRepoId } = await import("../../src/graph/repo-id.js");
    const { repoId } = resolveRepoId(dir);
    const { readFileSync, writeFileSync: wfs } = await import("node:fs");
    const metaPath = graphMetaPath(repoId);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    delete meta["tsconfig_fingerprint"];
    wfs(metaPath, JSON.stringify(meta, null, 2));

    const result = isGraphStaleCheap(dir, DEFAULT_CONFIG);
    assert.equal(result.stale, true, "missing tsconfig_fingerprint must invalidate on upgrade");
  });
});

test("isGraphStaleCheap: added/removed files surface in stale_files", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    await buildGraph({ cwd: dir, config: DEFAULT_CONFIG });

    writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    rmSync(join(dir, "src", "a.ts"));

    const result = isGraphStaleCheap(dir, DEFAULT_CONFIG);
    assert.equal(result.missing, false);
    assert.equal(result.stale, true);
    assert.deepEqual(result.stale_files.sort(), ["src/a.ts", "src/b.ts"]);
  });
});
