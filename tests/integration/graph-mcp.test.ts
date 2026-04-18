import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "dist/cli/entry.js");
const FIXTURE = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "tests/fixtures/graph-fixture-repo",
);

test("graph mcp server: exposes tools and returns focused context", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-graph-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-graph-repo-"));
  try {
    cpSync(FIXTURE, repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, "graph", "serve", "--path", repo],
      env: { ...process.env, HOME: home } as Record<string, string>,
    });
    const client = new Client({ name: "tokenomy-test", version: "1.0.0" });
    await client.connect(transport);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      [
        "build_or_update_graph",
        "find_usages",
        "get_impact_radius",
        "get_minimal_context",
        "get_review_context",
      ],
    );

    const built = await client.callTool({ name: "build_or_update_graph", arguments: {} });
    const builtPayload = JSON.parse(built.content[0]!.text);
    assert.equal(builtPayload.ok, true);
    assert.equal(builtPayload.data.built, true);

    const minimal = await client.callTool({
      name: "get_minimal_context",
      arguments: { target: { file: "src/index.ts" }, depth: 1 },
    });
    const minimalPayload = JSON.parse(minimal.content[0]!.text);
    assert.equal(minimalPayload.ok, true);
    assert.equal(minimalPayload.data.focal.id, "file:src/index.ts");
    assert.ok(Array.isArray(minimalPayload.data.neighbors));

    const review = await client.callTool({
      name: "get_review_context",
      arguments: { files: ["src/index.ts", "src/foo.ts"] },
    });
    const reviewPayload = JSON.parse(review.content[0]!.text);
    assert.equal(reviewPayload.ok, true);
    assert.deepEqual(reviewPayload.data.changed_files, ["src/foo.ts", "src/index.ts"]);

    const usages = await client.callTool({
      name: "find_usages",
      arguments: { target: { file: "src/foo.ts" } },
    });
    const usagesPayload = JSON.parse(usages.content[0]!.text);
    assert.equal(usagesPayload.ok, true);
    assert.equal(usagesPayload.data.focal.id, "file:src/foo.ts");
    assert.ok(Array.isArray(usagesPayload.data.call_sites));

    await transport.close();
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
