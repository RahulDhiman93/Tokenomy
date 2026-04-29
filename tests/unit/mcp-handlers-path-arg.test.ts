import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _resetQueryCacheForTests,
  dispatchGraphTool,
} from "../../src/mcp/handlers.js";
import { TOOL_DEFS } from "../../src/mcp/schemas.js";

const sandbox = (): { home: string; repoA: string; repoB: string; cleanup: () => void } => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-path-arg-home-"));
  const repoA = mkdtempSync(join(tmpdir(), "tokenomy-path-arg-A-"));
  const repoB = mkdtempSync(join(tmpdir(), "tokenomy-path-arg-B-"));
  for (const repo of [repoA, repoB]) {
    mkdirSync(join(repo, "src"), { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "T"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "t@x.test"], { cwd: repo, stdio: "ignore" });
    writeFileSync(
      join(repo, "src", "marker.ts"),
      `export const id = "${repo === repoA ? "A" : "B"}";\n`,
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
  }
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  _resetQueryCacheForTests();
  return {
    home,
    repoA,
    repoB,
    cleanup: () => {
      if (prev === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prev;
      _resetQueryCacheForTests();
      rmSync(home, { recursive: true, force: true });
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    },
  };
};

test("TOOL_DEFS: every tool's input schema declares optional `path`", () => {
  for (const tool of TOOL_DEFS) {
    const props = tool.inputSchema.properties ?? {};
    assert.ok(props["path"], `tool ${tool.name} missing path arg in schema`);
    assert.equal(props["path"]?.type, "string");
    // path is optional; should not appear in `required`.
    assert.equal(
      (tool.inputSchema.required ?? []).includes("path"),
      false,
      `tool ${tool.name} marks path as required`,
    );
  }
});

test("dispatchGraphTool: build_or_update_graph routes to args.path even when server cwd differs", async () => {
  const { repoA, repoB, cleanup } = sandbox();
  try {
    // Server cwd is repoA but the call targets repoB.
    const result = (await dispatchGraphTool(
      "build_or_update_graph",
      { path: repoB },
      repoA,
    )) as { ok: boolean; data?: { built: boolean; repo_id: string; node_count: number } };
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.data!.built, true);
    // Built node count should be > 0 since repoB has src/marker.ts.
    assert.ok(result.data!.node_count > 0);
  } finally {
    cleanup();
  }
});

test("dispatchGraphTool: get_minimal_context with path resolves the right repo's graph", async () => {
  const { repoA, repoB, cleanup } = sandbox();
  try {
    // Build graphs for both repos.
    await dispatchGraphTool("build_or_update_graph", { path: repoA }, repoA);
    await dispatchGraphTool("build_or_update_graph", { path: repoB }, repoA);
    // Server cwd points at A, but we ask about B's file via path arg.
    const r = (await dispatchGraphTool(
      "get_minimal_context",
      { target: { file: "src/marker.ts" }, path: repoB },
      repoA,
    )) as { ok: boolean; data?: { focal: { file?: string } } };
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.equal(r.data!.focal.file, "src/marker.ts");
  } finally {
    cleanup();
  }
});
