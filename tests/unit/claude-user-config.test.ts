import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getClaudeMcpServer,
  removeClaudeMcpServer,
  upsertClaudeMcpServer,
} from "../../src/util/claude-user-config.js";

const withSandbox = (fn: () => void): void => {
  const tmp = mkdtempSync(join(tmpdir(), "tokenomy-claude-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = tmp;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
};

test("upsertClaudeMcpServer: creates ~/.claude.json with stdio entry", () => {
  withSandbox(() => {
    upsertClaudeMcpServer("tokenomy-graph", {
      command: "tokenomy",
      args: ["graph", "serve", "--path", "/repo"],
    });
    const parsed = JSON.parse(readFileSync(join(process.env["HOME"]!, ".claude.json"), "utf8"));
    assert.deepEqual(parsed.mcpServers["tokenomy-graph"], {
      type: "stdio",
      command: "tokenomy",
      args: ["graph", "serve", "--path", "/repo"],
      env: {},
    });
  });
});

test("upsertClaudeMcpServer: preserves unrelated top-level keys", () => {
  withSandbox(() => {
    const home = process.env["HOME"]!;
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        claudeCodeFirstTokenDate: "2024-01-01",
        onboardingDone: true,
        mcpServers: { other: { type: "stdio", command: "x", args: [], env: {} } },
      }),
    );
    upsertClaudeMcpServer("tokenomy-graph", {
      command: "tokenomy",
      args: ["graph", "serve", "--path", "/repo"],
    });
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    assert.equal(parsed.claudeCodeFirstTokenDate, "2024-01-01");
    assert.equal(parsed.onboardingDone, true);
    assert.ok(parsed.mcpServers.other);
    assert.ok(parsed.mcpServers["tokenomy-graph"]);
  });
});

test("removeClaudeMcpServer: deletes only the named entry", () => {
  withSandbox(() => {
    const home = process.env["HOME"]!;
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "tokenomy-graph": { type: "stdio", command: "x", args: [], env: {} },
          other: { type: "stdio", command: "y", args: [], env: {} },
        },
      }),
    );
    const removed = removeClaudeMcpServer("tokenomy-graph");
    assert.equal(removed, true);
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    assert.equal(parsed.mcpServers["tokenomy-graph"], undefined);
    assert.ok(parsed.mcpServers.other);
  });
});

test("removeClaudeMcpServer: drops mcpServers key when last entry removed", () => {
  withSandbox(() => {
    const home = process.env["HOME"]!;
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        other: "preserved",
        mcpServers: { "tokenomy-graph": { type: "stdio", command: "x", args: [], env: {} } },
      }),
    );
    removeClaudeMcpServer("tokenomy-graph");
    const parsed = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"));
    assert.equal(parsed.mcpServers, undefined);
    assert.equal(parsed.other, "preserved");
  });
});

test("removeClaudeMcpServer: returns false when server not present", () => {
  withSandbox(() => {
    const home = process.env["HOME"]!;
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    assert.equal(removeClaudeMcpServer("tokenomy-graph"), false);
  });
});

test("getClaudeMcpServer: returns undefined on missing file", () => {
  withSandbox(() => {
    assert.equal(getClaudeMcpServer("anything"), undefined);
  });
});
