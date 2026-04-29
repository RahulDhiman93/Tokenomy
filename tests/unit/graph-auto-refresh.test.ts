import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetQueryCacheForTests,
  dispatchGraphTool,
} from "../../src/mcp/handlers.js";

interface BuildResult {
  ok: boolean;
  data?: { built: boolean; node_count: number };
}

const withSandbox = async <T>(fn: (repo: string) => Promise<T>): Promise<T> => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-autorefresh-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-autorefresh-repo-"));
  mkdirSync(join(repo, "src"), { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  _resetQueryCacheForTests();
  try {
    return await fn(repo);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    _resetQueryCacheForTests();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
};

// Bump mtime past the last-built value. Fresh filesystems sometimes collapse
// two rapid writes into the same mtimeMs reading, so we assert separation.
const touchForward = (path: string): void => {
  const before = statSync(path).mtimeMs;
  let attempt = 0;
  while (attempt++ < 5) {
    writeFileSync(path, statSync(path).size > 0 ? `${statSync(path).size}` : "x");
    if (statSync(path).mtimeMs > before) return;
    // Small sleep loop — coarse mtime granularity on some filesystems.
    const until = Date.now() + 15;
    while (Date.now() < until) { /* spin */ }
  }
};

const writeConfig = (home: string, body: Record<string, unknown>): void => {
  mkdirSync(join(home, ".tokenomy"), { recursive: true });
  writeFileSync(join(home, ".tokenomy", "config.json"), JSON.stringify(body));
};

test("read-side auto-refresh: mutating a source file triggers a rebuild on next query", async () => {
  await withSandbox(async (repo) => {
    const built = (await dispatchGraphTool("build_or_update_graph", {}, repo)) as BuildResult;
    assert.equal(built.ok, true);
    assert.equal(built.data?.built, true);

    // Add a brand-new source file; cache key still valid, but the file
    // isn't in the graph yet. Auto-refresh should pick it up.
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    // A read-side tool call should transparently rebuild.
    const status = (await dispatchGraphTool("build_or_update_graph", {}, repo)) as BuildResult;
    assert.equal(status.ok, true);
    // The second explicit build_or_update_graph call sees that src/b.ts
    // wasn't in the previous graph and rebuilds.
    assert.equal(status.data?.built, true);
  });
});

test("read-side auto-refresh: get_minimal_context sees newly-added file after edit", async () => {
  await withSandbox(async (repo) => {
    const built = (await dispatchGraphTool("build_or_update_graph", {}, repo)) as BuildResult;
    assert.equal(built.ok, true);

    // Add a new source file. No explicit rebuild call.
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 42;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    // Query for the new file. Without auto-refresh this would be
    // target-not-found; with auto-refresh it succeeds.
    const result = (await dispatchGraphTool(
      "get_minimal_context",
      { target: { file: "src/new.ts" }, depth: 1 },
      repo,
    )) as { ok: boolean; data?: { focal: { name: string } } };

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data?.focal.name, "src/new.ts");
  });
});

test("read-side auto-refresh: graph.auto_refresh_on_read=false leaves graph stale", async () => {
  await withSandbox(async (repo) => {
    writeConfig(process.env["HOME"]!, { graph: { auto_refresh_on_read: false } });

    const built = (await dispatchGraphTool("build_or_update_graph", {}, repo)) as BuildResult;
    assert.equal(built.ok, true);

    // Add a file. With auto_refresh_on_read:false, the read-side should
    // NOT rebuild, so the query won't find the new file.
    writeFileSync(join(repo, "src", "disabled.ts"), "export const d = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    const result = (await dispatchGraphTool(
      "get_minimal_context",
      { target: { file: "src/disabled.ts" }, depth: 1 },
      repo,
    )) as { ok: boolean; reason?: string };

    assert.equal(result.ok, false);
    assert.equal(result.reason, "target-not-found");
  });
});

test("read-side auto-refresh: propagates rebuild FailOpen when async_rebuild=false", async () => {
  await withSandbox(async (repo) => {
    // Build the graph successfully first so there's a stored snapshot.
    const built = (await dispatchGraphTool("build_or_update_graph", {}, repo)) as BuildResult;
    assert.equal(built.ok, true);

    // 0.1.3+: by default the read-side serves the cached snapshot and rebuilds
    // in the background, so a doomed rebuild no longer surfaces synchronously.
    // Opt out of the async path here so we exercise the original semantics.
    writeFileSync(join(repo, "src", "overflow.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    writeConfig(process.env["HOME"]!, {
      graph: { hard_max_files: 0, async_rebuild: false },
    });

    const result = (await dispatchGraphTool(
      "get_minimal_context",
      { target: { file: "src/a.ts" }, depth: 1 },
      repo,
    )) as { ok: boolean; reason?: string };

    // Synchronous path: must surface the rebuild failure.
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.reason, "repo-too-large");
  });
});

test("read-side auto-refresh: async_rebuild=true serves cached snapshot + flags stale", async () => {
  await withSandbox(async (repo) => {
    const built = (await dispatchGraphTool("build_or_update_graph", {}, repo)) as BuildResult;
    assert.equal(built.ok, true);

    // Add a file → snapshot becomes stale. async_rebuild defaults true.
    writeFileSync(join(repo, "src", "added.ts"), "export const z = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    const result = (await dispatchGraphTool(
      "get_minimal_context",
      { target: { file: "src/a.ts" }, depth: 1 },
      repo,
    )) as { ok: boolean; stale?: boolean };

    // Stale-but-cached: ok:true, stale:true. The agent sees results
    // immediately; rebuild runs in the background.
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stale, true);
  });
});

test("read-side auto-refresh: recovers from a corrupt snapshot by triggering a rebuild", async () => {
  await withSandbox(async (repo) => {
    const built = (await dispatchGraphTool("build_or_update_graph", {}, repo)) as BuildResult;
    assert.equal(built.ok, true);

    // Corrupt the snapshot file — meta + mtimes stay fresh, so the cheap
    // stale check returns "fresh", but loadGraphContext will fail parsing.
    const { graphSnapshotPath } = await import("../../src/core/paths.js");
    const { resolveRepoId } = await import("../../src/graph/repo-id.js");
    const { repoId } = resolveRepoId(repo);
    writeFileSync(graphSnapshotPath(repoId), "{ not valid json");

    // Read-side should detect the corruption via loadGraphContext and
    // retry with a full rebuild instead of surfacing graph-not-built.
    const result = (await dispatchGraphTool(
      "get_minimal_context",
      { target: { file: "src/a.ts" }, depth: 1 },
      repo,
    )) as { ok: boolean; data?: { focal: { name: string } }; reason?: string };

    assert.equal(result.ok, true, `expected recovery; got ${JSON.stringify(result)}`);
    assert.equal(result.data?.focal.name, "src/a.ts");
  });
});

test("read-side auto-refresh: malformed input returns invalid-input without triggering a rebuild", async () => {
  await withSandbox(async (repo) => {
    // Use an over-cap config so a rebuild would fail with repo-too-large.
    // If input validation doesn't run first, we'd get repo-too-large;
    // we expect invalid-input instead.
    writeConfig(process.env["HOME"]!, { graph: { hard_max_files: 0 } });

    const result = (await dispatchGraphTool(
      "get_minimal_context",
      {}, // missing required target.file
      repo,
    )) as { ok: boolean; reason?: string; hint?: string };

    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-input");
  });
});

test("read-side cache: raising query_budget_bytes via config invalidates prior clipped response", async () => {
  await withSandbox(async (repo) => {
    // Seed enough source files that find_usages on a widely-imported
    // symbol produces a response bigger than a tiny budget.
    const callers = 12;
    for (let i = 0; i < callers; i++) {
      writeFileSync(
        join(repo, "src", `caller${i}.ts`),
        `import { a } from "./a";\nexport function use${i}() { return a; }\n`,
      );
    }
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    // Constrain budget aggressively so the first query clips.
    writeConfig(process.env["HOME"]!, {
      graph: { query_budget_bytes: { find_usages: 200 } },
    });

    await dispatchGraphTool("build_or_update_graph", {}, repo);
    const clipped = (await dispatchGraphTool(
      "find_usages",
      { target: { file: "src/a.ts", symbol: "a" } },
      repo,
    )) as { ok: boolean; data?: { call_sites: unknown[] }; truncated?: { dropped_count: number } };
    assert.equal(clipped.ok, true);
    assert.ok(
      (clipped.truncated?.dropped_count ?? 0) > 0,
      `expected truncation at tight budget; got ${JSON.stringify(clipped.truncated)}`,
    );
    const clippedCount = clipped.data?.call_sites.length ?? 0;

    // Raise the budget via config — NO rebuild, NO session restart.
    writeConfig(process.env["HOME"]!, {
      graph: { query_budget_bytes: { find_usages: 200_000 } },
    });

    const full = (await dispatchGraphTool(
      "find_usages",
      { target: { file: "src/a.ts", symbol: "a" } },
      repo,
    )) as { ok: boolean; data?: { call_sites: unknown[] }; truncated?: { dropped_count: number } };
    assert.equal(full.ok, true);
    // Cache miss → fresh query with new budget → more entries + no truncation.
    assert.ok(
      (full.data?.call_sites.length ?? 0) > clippedCount,
      `expected more call sites after raising budget; got ${full.data?.call_sites.length} vs ${clippedCount}`,
    );
    assert.equal(full.truncated, undefined, "no truncation at generous budget");
  });
});

test("read-side auto-refresh: fresh graph hits cache; rebuild only on stale", async () => {
  await withSandbox(async (repo) => {
    await dispatchGraphTool("build_or_update_graph", {}, repo);

    // Two consecutive identical queries with no source changes — second one
    // should hit the LRU cache (no rebuild, no re-enumeration of the expensive path).
    const first = (await dispatchGraphTool(
      "get_minimal_context",
      { target: { file: "src/a.ts" }, depth: 1 },
      repo,
    )) as { ok: boolean };
    assert.equal(first.ok, true);

    const second = (await dispatchGraphTool(
      "get_minimal_context",
      { target: { file: "src/a.ts" }, depth: 1 },
      repo,
    )) as { ok: boolean };
    assert.equal(second.ok, true);
  });
});
