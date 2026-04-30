import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { enumerateGraphFiles } from "../../src/graph/enumerate.js";
import { buildGraph } from "../../src/graph/build.js";
import { fingerprintExcludes } from "../../src/graph/exclude-fingerprint.js";
import type { Config } from "../../src/core/types.js";

const withTmpRepo = async <T>(fn: (dir: string) => T | Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-graph-exclude-"));
  const prevHome = process.env["HOME"];
  // Sandbox HOME so graph artifacts don't pollute the user's ~/.tokenomy.
  process.env["HOME"] = mkdtempSync(join(tmpdir(), "tokenomy-home-"));
  try {
    return await fn(dir);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(dir, { recursive: true, force: true });
  }
};

test("enumerate: config exclude filters files (git mode)", () => {
  return withTmpRepo((dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(dir, "public", "bundle.js"), "var x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, exclude: ["public/**"] },
    };
    const result = enumerateGraphFiles(dir, cfg);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.files, ["src/app.ts"]);
    assert.deepEqual(result.skipped_files, ["public/bundle.js"]);
  });
});

test("enumerate: default exclude skips tracked generated directories", () => {
  return withTmpRepo((dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    mkdirSync(join(dir, ".next", "server"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(dir, "dist", "bundle.js"), "var x = 1;\n");
    writeFileSync(join(dir, ".next", "server", "page.js"), "var y = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const result = enumerateGraphFiles(dir, DEFAULT_CONFIG);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.files, ["src/app.ts"]);
    assert.deepEqual(result.skipped_files, [".next/server/page.js", "dist/bundle.js"]);
  });
});

test("enumerate: exclude filter runs BEFORE hard_max_files cap", () => {
  // 10 excluded vendor files + 2 real source files. hard_max_files=3.
  // Without in-loop filtering the vendor files would trip repo-too-large
  // before any exclude could apply.
  return withTmpRepo((dir) => {
    mkdirSync(join(dir, "vendor"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, "vendor", `v${i}.js`), "var x=1;\n");
    }
    writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "src", "b.ts"), "export const b = 2;\n");

    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: {
        ...DEFAULT_CONFIG.graph,
        exclude: ["vendor/**"],
        hard_max_files: 3,
      },
    };
    const result = enumerateGraphFiles(dir, cfg);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.files.length, 2);
    assert.equal(result.skipped_files.length, 10);
  });
});

test("fingerprintExcludes is stable and order/dedup-invariant", () => {
  assert.equal(fingerprintExcludes([]), fingerprintExcludes([]));
  assert.equal(
    fingerprintExcludes(["a", "b"]),
    fingerprintExcludes(["b", "a", "a"]),
  );
  assert.notEqual(fingerprintExcludes(["a"]), fingerprintExcludes(["b"]));
  // Known stable anchor: hash of "[]" stays the same across runs.
  assert.equal(fingerprintExcludes([]).length, 64);
});

test("buildGraph: skipped_files populated on fresh build + round-trips through meta on cached rebuild", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(dir, "public", "vendor.js"), "var x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, exclude: ["public/**"] },
    };

    const fresh = await buildGraph({ cwd: dir, config: cfg });
    assert.equal(fresh.ok, true);
    if (!fresh.ok) return;
    assert.equal(fresh.data.built, true);
    assert.deepEqual(fresh.data.skipped_files, ["public/vendor.js"]);

    // Same config, no file changes — cached path. skipped_files must
    // round-trip through meta.json, not hardcode to [].
    const cached = await buildGraph({ cwd: dir, config: cfg });
    assert.equal(cached.ok, true);
    if (!cached.ok) return;
    assert.equal(cached.data.built, false);
    assert.deepEqual(cached.data.skipped_files, ["public/vendor.js"]);
  });
});

test("buildGraph: changing exclude set invalidates cached graph even if no source changed", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "vendor"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(dir, "vendor", "lib.js"), "var x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const cfgA: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, exclude: [] },
    };
    const first = await buildGraph({ cwd: dir, config: cfgA });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.data.built, true);
    assert.deepEqual(first.data.skipped_files, []);

    // Different exclude list — cached graph should be invalidated by the
    // exclude_fingerprint check.
    const cfgB: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, exclude: ["vendor/**"] },
    };
    const second = await buildGraph({ cwd: dir, config: cfgB });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.data.built, true, "exclude change must force rebuild");
    assert.deepEqual(second.data.skipped_files, ["vendor/lib.js"]);
  });
});

test("buildGraph: pre-upgrade meta without exclude_fingerprint triggers one free rebuild", async () => {
  await withTmpRepo(async (dir) => {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "app.ts"), "export const app = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });

    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, exclude: [] },
    };
    const first = await buildGraph({ cwd: dir, config: cfg });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    // Simulate a pre-upgrade meta.json by stripping exclude_fingerprint.
    const { graphMetaPath } = await import("../../src/core/paths.js");
    const { resolveRepoId } = await import("../../src/graph/repo-id.js");
    const { repoId } = resolveRepoId(dir);
    const metaPath = graphMetaPath(repoId);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    delete meta["exclude_fingerprint"];
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const rebuilt = await buildGraph({ cwd: dir, config: cfg });
    assert.equal(rebuilt.ok, true);
    if (!rebuilt.ok) return;
    assert.equal(rebuilt.data.built, true, "missing exclude_fingerprint must force rebuild");
  });
});
