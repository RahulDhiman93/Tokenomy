import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchMcpJson, removeMcpJson } from "../../src/cli/agents/common.js";

test("patchMcpJson and removeMcpJson are idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-agent-"));
  try {
    const path = join(dir, "mcp.json");
    const first = patchMcpJson("cursor", path, "/repo", false);
    assert.equal(first.installed, true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(parsed.mcpServers["tokenomy-graph"], {
      command: "tokenomy",
      args: ["graph", "serve", "--path", "/repo"],
    });
    patchMcpJson("cursor", path, "/repo2", false);
    const updated = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(updated.mcpServers["tokenomy-graph"].args[3], "/repo2");
    const removed = removeMcpJson("cursor", path, false);
    assert.equal(removed.installed, true);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).mcpServers, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

