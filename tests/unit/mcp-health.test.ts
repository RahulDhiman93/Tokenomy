import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { TOOL_DEFS } from "../../src/mcp/schemas.js";
import { dispatchGraphTool } from "../../src/mcp/handlers.js";
import { TOKENOMY_VERSION } from "../../src/core/version.js";

test("schemas: TOOL_DEFS includes the health tool", () => {
  const health = TOOL_DEFS.find((t) => t.name === "health");
  assert.ok(health, "health tool present");
  assert.equal(typeof health!.description, "string");
});

test("dispatchGraphTool('health'): returns structured health snapshot", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-health-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-health-repo-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    execSync("git init -q", { cwd: repo });
    execSync('git -c user.email=a@b.com -c user.name=a commit --allow-empty -q -m init', {
      cwd: repo,
    });
    const result = await dispatchGraphTool("health", {}, repo);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.equal(data["version"], TOKENOMY_VERSION);
    assert.equal(typeof data["uptime_ms"], "number");
    assert.equal(typeof data["worker_active"], "boolean");
    assert.equal(typeof data["inflight"], "number");
    assert.equal(typeof data["inflight_max"], "number");
    assert.equal(typeof data["snapshot_integrity_ok"], "boolean");
    assert.equal(typeof data["schema_version"], "number");
    // snapshot_sha256 is null on a fresh repo (no graph built yet).
    assert.equal(data["snapshot_sha256"], null);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("health: schema_version matches GRAPH_SCHEMA_VERSION (forward-compat probe)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-health-vers-"));
  try {
    execSync("git init -q", { cwd: repo });
    execSync('git -c user.email=a@b.com -c user.name=a commit --allow-empty -q -m init', {
      cwd: repo,
    });
    const result = await dispatchGraphTool("health", {}, repo);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const data = result.data as Record<string, unknown>;
    assert.equal(data["schema_version"], 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
