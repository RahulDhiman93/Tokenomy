import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchMcpJson, removeMcpJson } from "../../src/cli/agents/common.js";
import {
  removeCodexTokenomyHooks,
  upsertCodexTokenomyHooks,
} from "../../src/util/codex-config.js";

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

test("upsertCodexTokenomyHooks installs prompt/session hooks and enables feature flag", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-codex-"));
  const hooksPath = join(dir, "hooks.json");
  const configPath = join(dir, "config.toml");
  try {
    const result = upsertCodexTokenomyHooks("/tmp/tokenomy-hook", false, hooksPath, configPath);
    assert.equal(result.hooksPath, hooksPath);
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(hooks.hooks.SessionStart[0].matcher, "startup|resume");
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, "/tmp/tokenomy-hook");
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, "/tmp/tokenomy-hook");

    const config = readFileSync(configPath, "utf8");
    assert.match(config, /\[features\]/);
    assert.match(config, /codex_hooks = true/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeCodexTokenomyHooks removes only Tokenomy command hooks", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-codex-"));
  const hooksPath = join(dir, "hooks.json");
  const configPath = join(dir, "config.toml");
  try {
    upsertCodexTokenomyHooks("/tmp/tokenomy-hook", false, hooksPath, configPath);
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [
            { matcher: "startup|resume", hooks: [{ type: "command", command: "/tmp/tokenomy-hook" }] },
            { matcher: "startup", hooks: [{ type: "command", command: "/tmp/other-hook" }] },
          ],
          UserPromptSubmit: [
            { hooks: [{ type: "command", command: "/tmp/tokenomy-hook" }] },
          ],
        },
      }),
    );

    removeCodexTokenomyHooks("/tmp/tokenomy-hook", false, hooksPath, configPath);
    const hooks = JSON.parse(readFileSync(hooksPath, "utf8"));
    assert.equal(hooks.hooks.SessionStart.length, 1);
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, "/tmp/other-hook");
    assert.equal(hooks.hooks.UserPromptSubmit, undefined);
    assert.equal(existsSync(configPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
