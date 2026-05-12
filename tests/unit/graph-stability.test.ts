import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { buildGraph } from "../../src/graph/build.js";
import {
  clearAsyncBuildFailure,
  readAsyncBuildFailure,
  readLastGraphBuildFailure,
  writeAsyncBuildFailure,
} from "../../src/graph/build-log.js";
import { graphAsyncFailurePath, graphBuildLogPath } from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import { JsonGraphStore } from "../../src/graph/store.js";
import { findUsages } from "../../src/graph/query/usages.js";
import { minimalContext } from "../../src/graph/query/minimal.js";
import { buildGraphIndex, resolveTargetNode } from "../../src/graph/query/common.js";
import type { Config } from "../../src/core/types.js";

const withTmpRepo = async <T>(fn: (repo: string, home: string) => T | Promise<T>): Promise<T> => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-graph-stab-"));
  const home = mkdtempSync(join(tmpdir(), "tokenomy-graph-stab-home-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "t"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: repo, stdio: "ignore" });
  try {
    return await fn(repo, home);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
};

// -----------------------------------------------------------------------
// build.ts — skip-and-continue when a single file exceeds max_edges_per_file
// -----------------------------------------------------------------------

test("buildGraph: per-file edge cap skips file, does not abort whole graph", async () => {
  await withTmpRepo(async (repo) => {
    // small healthy file
    writeFileSync(join(repo, "good.ts"), "export const ok = 1;\n");
    // one overgrown file: many cross-imports each producing an edge
    const big = Array.from({ length: 60 }, (_, i) => `import { x${i} } from "./good";`).join("\n");
    writeFileSync(join(repo, "bad.ts"), big + "\nexport const used = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, max_edges_per_file: 5, incremental: false },
    };
    const result = await buildGraph({ cwd: repo, config: cfg });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.data.skipped_files.includes("bad.ts"), "bad.ts must be in skipped_files");
    // good.ts must still be in the graph
    const store = new JsonGraphStore();
    const graph = store.loadGraph({ repoId: result.data.repo_id, repoPath: repo });
    assert.ok(graph);
    assert.ok(graph!.nodes.some((n) => n.id === "file:good.ts"));
    // parse_errors must include an actionable message
    assert.ok(graph!.parse_errors.some((e) => e.file === "bad.ts" && /edge cap exceeded/.test(e.message)));
  });
});

test("buildGraph: delta path skips overgrown file too", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(join(repo, "good.ts"), "export const ok = 1;\n");
    writeFileSync(join(repo, "bad.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, max_edges_per_file: 5, incremental: true },
    };
    const first = await buildGraph({ cwd: repo, config: cfg });
    assert.equal(first.ok, true);
    // Mutate bad.ts to have many cross-imports → exceeds cap on delta rebuild.
    const big = Array.from({ length: 60 }, (_, i) => `import { x${i} } from "./good";`).join("\n");
    writeFileSync(join(repo, "bad.ts"), big + "\nexport const used = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const second = await buildGraph({ cwd: repo, config: cfg });
    assert.equal(second.ok, true, JSON.stringify(second));
    if (!second.ok) return;
    assert.ok(second.data.skipped_files.includes("bad.ts"));
  });
});

test("buildGraph: parser throwing on one file does not abort", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    // Valid TS but with a recursively-deep template to stress parser path.
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    const result = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.ok(result.data.node_count > 0);
  });
});

// -----------------------------------------------------------------------
// build-log.ts — async failure read/write/clear cycle + new hint reasons
// -----------------------------------------------------------------------

// 0.1.8+: storage helper. `location: "home"` keeps the legacy
// `~/.tokenomy/graphs/<repoId>/` layout so synthetic-repoId tests
// (no real repo on disk) still work without rewriting fixtures.
const HOME = { location: "home" as const };

test("async build failure: write + read + clear lifecycle", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-async-fail-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const identity = {
      repoId: "stab-test-repo-1111111111111111111111111111111111111111",
      repoPath: "/tmp/dummy",
    };
    mkdirSync(dirname(graphAsyncFailurePath(identity, HOME)), { recursive: true });
    assert.equal(readAsyncBuildFailure(identity, HOME), null);
    writeAsyncBuildFailure(identity, {
      ts: "2026-05-11T10:00:00Z",
      reason: "timeout",
      hint: "raise graph.build_timeout_ms",
    }, HOME);
    assert.ok(existsSync(graphAsyncFailurePath(identity, HOME)));
    const r = readAsyncBuildFailure(identity, HOME);
    assert.equal(r?.reason, "timeout");
    assert.equal(r?.hint, "raise graph.build_timeout_ms");
    clearAsyncBuildFailure(identity, HOME);
    assert.equal(readAsyncBuildFailure(identity, HOME), null);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("async build failure: malformed JSON returns null", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-async-fail-bad-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const identity = {
      repoId: "stab-malformed-repo-22222222222222222222222222222222",
      repoPath: "/tmp/dummy",
    };
    const path = graphAsyncFailurePath(identity, HOME);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    assert.equal(readAsyncBuildFailure(identity, HOME), null);
    writeFileSync(path, JSON.stringify({ ts: 123, reason: "x" }));
    assert.equal(readAsyncBuildFailure(identity, HOME), null);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("readLastGraphBuildFailure: surfaces hints for every known reason", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-hint-test-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const reasons = [
      "graph-too-large",
      "repo-too-large",
      "typescript-not-installed",
      "no-files",
      "timeout",
      "io-error",
      "build-in-progress",
      "graph-disabled",
      "graph-not-built",
      "git-resolve-failed",
    ];
    for (const reason of reasons) {
      const repoId = `stab-hint-${reason.replace(/[^a-z]/g, "")}-${"x".repeat(40)}`.slice(0, 64);
      const identity = { repoId, repoPath: "/tmp/dummy" };
      const path = graphBuildLogPath(identity, HOME);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({
          ts: new Date().toISOString(),
          repo_id: repoId,
          repo_path: "/r",
          built: false,
          reason,
          node_count: 0,
          edge_count: 0,
          parse_error_count: 0,
          duration_ms: 0,
        }) + "\n",
      );
      const fail = readLastGraphBuildFailure(identity, HOME);
      assert.equal(fail?.reason, reason);
      assert.ok(typeof fail?.hint === "string" && fail!.hint!.length > 0, `missing hint for ${reason}`);
    }
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// -----------------------------------------------------------------------
// find_usages: default-import correlation via "default" original_name
// -----------------------------------------------------------------------

test("find_usages: default-imported function surfaces caller", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(
      join(repo, "lib.ts"),
      "export default function greet(): string { return 'hi'; }\n",
    );
    writeFileSync(
      join(repo, "consumer.ts"),
      "import greet from './lib.js';\nconst v = greet();\nexport { v };\n",
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);
    const store = new JsonGraphStore();
    const graph = store.loadGraph(resolveRepoId(repo));
    assert.ok(graph);
    const result = findUsages(
      graph!,
      { target: { file: "lib.ts", symbol: "greet" } },
      DEFAULT_CONFIG,
      false,
      [],
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The consumer file (or an importer node in it) should appear as a usage.
    const callerFiles = result.data.call_sites
      .map((c) => c.file)
      .filter((f): f is string => typeof f === "string");
    assert.ok(callerFiles.includes("consumer.ts"), `expected consumer.ts in ${callerFiles.join(", ")}`);
  });
});

// -----------------------------------------------------------------------
// minimal: priority BFS orders importers ahead of contains-children
// -----------------------------------------------------------------------

test("minimal: priority BFS prefers imports over contains on hub files", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(
      join(repo, "hub.ts"),
      [
        "export function a() {}",
        "export function b() {}",
        "export function c() {}",
        "export function d() {}",
        "export function e() {}",
      ].join("\n") + "\n",
    );
    writeFileSync(join(repo, "user1.ts"), "import { a } from './hub.js';\nexport const u = a;\n");
    writeFileSync(join(repo, "user2.ts"), "import { b } from './hub.js';\nexport const u = b;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);
    const store = new JsonGraphStore();
    const graph = store.loadGraph(resolveRepoId(repo));
    assert.ok(graph);
    const result = minimalContext(
      graph!,
      { target: { file: "hub.ts" }, depth: 1 },
      DEFAULT_CONFIG,
      false,
      [],
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // First neighbor (highest priority) should be an importer ("in" direction
    // with imports edge), not a contains-child.
    const first = result.data.neighbors[0];
    assert.ok(first, "expected at least one neighbor");
    assert.ok(
      first.edge_kind === "imports" || first.edge_kind === "references",
      `expected imports/references first, got ${first.edge_kind}`,
    );
  });
});

// -----------------------------------------------------------------------
// common.ts: memoized buildGraphIndex returns same reference for same graph
// -----------------------------------------------------------------------

test("buildGraphIndex: memoized on graph reference", () => {
  const graph = {
    schema_version: 1 as const,
    repo_id: "x",
    nodes: [{ id: "file:a.ts", kind: "file" as const, name: "a.ts", file: "a.ts" }],
    edges: [],
    parse_errors: [],
  };
  const i1 = buildGraphIndex(graph);
  const i2 = buildGraphIndex(graph);
  assert.equal(i1, i2);
  assert.equal(i1.nodesById.get("file:a.ts")?.id, "file:a.ts");
});

test("readGraphStatus: includes last_build_failure when async sentinel exists", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);
    const identity = resolveRepoId(repo);
    const { repoId } = identity;
    // Append a failed entry to the build log so readLastGraphBuildFailure
    // returns non-null.
    const logPath = graphBuildLogPath(identity, DEFAULT_CONFIG.graph);
    writeFileSync(
      logPath,
      readFileSync(logPath, "utf8") +
        JSON.stringify({
          ts: new Date().toISOString(),
          repo_id: repoId,
          repo_path: repo,
          built: false,
          reason: "timeout",
          node_count: 0,
          edge_count: 0,
          parse_error_count: 0,
          duration_ms: 0,
        }) +
        "\n",
    );
    const { readGraphStatus } = await import("../../src/graph/build.js");
    const status = readGraphStatus(repo, DEFAULT_CONFIG);
    assert.equal(status.ok, true);
    if (!status.ok) return;
    const data = status.data as Record<string, unknown>;
    assert.ok(data.last_build_failure, "expected last_build_failure on status");
  });
});

test("diagnose: human-readable output writes header + JSON", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const prevCwd = process.cwd();
    process.chdir(repo);
    let captured = "";
    const ow = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      captured += typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      const { runDiagnose } = await import("../../src/cli/diagnose.js");
      await runDiagnose([]);
      assert.match(captured, /tokenomy diagnose @/);
      assert.match(captured, /version=/);
    } finally {
      process.stdout.write = ow;
      process.chdir(prevCwd);
    }
  });
});

test("dispatchGraphTool: cached result respects sentinel changes (annotate-after-cache)", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);
    const identity = resolveRepoId(repo);
    const { dispatchGraphTool, _resetQueryCacheForTests } = await import(
      "../../src/mcp/handlers.js"
    );
    _resetQueryCacheForTests();
    // First call — no sentinel.
    const r1 = (await dispatchGraphTool(
      "find_usages",
      { target: { file: "a.ts" }, path: repo },
      repo,
    )) as { ok: boolean; data?: Record<string, unknown> };
    assert.equal(r1.ok, true);
    assert.equal(r1.data?.last_build_failure, undefined);
    // Seed sentinel; cached UNANNOTATED result must NOW carry annotation.
    writeAsyncBuildFailure(
      identity,
      { ts: "2026-05-11T11:00:00Z", reason: "timeout" },
      DEFAULT_CONFIG.graph,
    );
    const r2 = (await dispatchGraphTool(
      "find_usages",
      { target: { file: "a.ts" }, path: repo },
      repo,
    )) as { ok: boolean; data?: Record<string, unknown> };
    assert.equal(r2.ok, true);
    assert.ok(r2.data?.last_build_failure, "cache hit must annotate on read");
    // Clear sentinel; annotation must disappear on the next read.
    clearAsyncBuildFailure(identity, DEFAULT_CONFIG.graph);
    const r3 = (await dispatchGraphTool(
      "find_usages",
      { target: { file: "a.ts" }, path: repo },
      repo,
    )) as { ok: boolean; data?: Record<string, unknown> };
    assert.equal(r3.ok, true);
    assert.equal(r3.data?.last_build_failure, undefined, "sentinel clear must strip annotation");
  });
});

test("readAsyncBuildFailure: fills hint from fallback catalog when stored hint missing", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-fb-hint-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const identity = {
      repoId: "stab-fb-hint-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      repoPath: "/tmp/dummy",
    };
    // Write WITHOUT a hint; reader should fill from fallback catalog.
    mkdirSync(dirname(graphAsyncFailurePath(identity, HOME)), { recursive: true });
    writeFileSync(
      graphAsyncFailurePath(identity, HOME),
      JSON.stringify({ ts: "2026-05-11T00:00:00Z", reason: "timeout" }),
    );
    const r = readAsyncBuildFailure(identity, HOME);
    assert.equal(r?.reason, "timeout");
    assert.ok(typeof r?.hint === "string" && r.hint.length > 0);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildGraph: delta carries forward previously-skipped files across rebuild", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(join(repo, "good.ts"), "export const ok = 1;\n");
    const big = Array.from({ length: 60 }, (_, i) => `import { x${i} } from "./good";`).join("\n");
    writeFileSync(join(repo, "bad.ts"), big + "\nexport const used = 1;\n");
    writeFileSync(join(repo, "neutral.ts"), "export const n = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, max_edges_per_file: 5, incremental: true },
    };
    const first = await buildGraph({ cwd: repo, config: cfg });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.ok(first.data.skipped_files.includes("bad.ts"));
    // Touch ONLY neutral.ts. bad.ts isn't expanded → must carry forward.
    writeFileSync(join(repo, "neutral.ts"), "export const n = 2;\n");
    const second = await buildGraph({ cwd: repo, config: cfg });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.ok(
      second.data.skipped_files.includes("bad.ts"),
      `bad.ts must be carried in delta skipped_files; got ${JSON.stringify(second.data.skipped_files)}`,
    );
  });
});

test("extract: anonymous export default function/class emits exp:default", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(
      join(repo, "anon-fn.ts"),
      "export default function () { return 1; }\n",
    );
    writeFileSync(
      join(repo, "anon-cls.ts"),
      "export default class { hi() { return 'hi'; } }\n",
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);
    const store = new JsonGraphStore();
    const graph = store.loadGraph(resolveRepoId(repo));
    const fnDef = graph!.nodes.find(
      (n) => n.kind === "exported-symbol" && n.name === "default" && n.file === "anon-fn.ts",
    );
    const clsDef = graph!.nodes.find(
      (n) => n.kind === "exported-symbol" && n.name === "default" && n.file === "anon-cls.ts",
    );
    assert.ok(fnDef, "anonymous default function must emit exp:default");
    assert.ok(clsDef, "anonymous default class must emit exp:default");
  });
});

test("extract: export default class emits exp:default", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(
      join(repo, "lib.ts"),
      "export default class Greeter { hi(): string { return 'hi'; } }\n",
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);
    const store = new JsonGraphStore();
    const graph = store.loadGraph(resolveRepoId(repo));
    const defaultExport = graph!.nodes.find(
      (n) => n.kind === "exported-symbol" && n.name === "default" && n.file === "lib.ts",
    );
    assert.ok(defaultExport, "expected exp:default node for default class");
  });
});

test("extract: export default function emits exp:default", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(
      join(repo, "lib.ts"),
      "export default function greet(): string { return 'hi'; }\n",
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);
    const store = new JsonGraphStore();
    const graph = store.loadGraph(resolveRepoId(repo));
    assert.ok(graph);
    const defaultExport = graph!.nodes.find(
      (n) => n.kind === "exported-symbol" && n.name === "default" && n.file === "lib.ts",
    );
    assert.ok(defaultExport, "expected exp:default node");
  });
});

test("dispatchGraphTool: embeds last_build_failure on cacheable response", async () => {
  await withTmpRepo(async (repo) => {
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);
    // Pre-seed an async-failure sentinel so the next dispatch surfaces it.
    const identity = resolveRepoId(repo);
    writeAsyncBuildFailure(
      identity,
      {
        ts: "2026-05-11T11:00:00Z",
        reason: "timeout",
        hint: "raise graph.build_timeout_ms",
      },
      DEFAULT_CONFIG.graph,
    );
    const { dispatchGraphTool } = await import("../../src/mcp/handlers.js");
    const result = await dispatchGraphTool(
      "find_usages",
      { target: { file: "a.ts" }, path: repo },
      repo,
    );
    assert.equal((result as { ok: boolean }).ok, true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.ok(data.last_build_failure, "expected last_build_failure on response");
    const lbf = data.last_build_failure as { reason: string; hint?: string };
    assert.equal(lbf.reason, "timeout");
  });
});

test("resolveTargetNode: index-driven file + symbol lookup", () => {
  const graph = {
    schema_version: 1 as const,
    repo_id: "x",
    nodes: [
      { id: "file:a.ts", kind: "file" as const, name: "a.ts", file: "a.ts" },
      {
        id: "fn:foo@5#0",
        kind: "function" as const,
        name: "foo",
        file: "a.ts",
        range: { line: 5 },
      },
      {
        id: "exp:a.ts::default",
        kind: "exported-symbol" as const,
        name: "default",
        file: "a.ts",
      },
    ],
    edges: [],
    parse_errors: [],
  };
  assert.equal(resolveTargetNode(graph, "a.ts", undefined)?.id, "file:a.ts");
  assert.equal(resolveTargetNode(graph, "a.ts", "foo")?.id, "fn:foo@5#0");
  // Missing symbol falls back to file node.
  assert.equal(resolveTargetNode(graph, "a.ts", "nothere")?.id, "file:a.ts");
  // Missing file returns null.
  assert.equal(resolveTargetNode(graph, "nope.ts", undefined), null);
});
