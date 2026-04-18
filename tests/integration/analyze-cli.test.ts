import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "dist/cli/entry.js");

const synthesize = (projectsDir: string): void => {
  const session = join(projectsDir, "-fake-project", "session-1.jsonl");
  mkdirSync(join(projectsDir, "-fake-project"), { recursive: true });

  const lines: string[] = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-18T10:00:00Z",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__fake__big",
            input: { id: 1 },
          },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-18T10:00:01Z",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "text", text: "x".repeat(50_000) }],
          },
        ],
      },
    }),
    // Duplicate call — should fire dedup.
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-04-18T10:01:00Z",
      message: {
        content: [{ type: "tool_use", id: "t2", name: "mcp__fake__big", input: { id: 1 } }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-04-18T10:01:01Z",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "t2",
            content: [{ type: "text", text: "x".repeat(50_000) }],
          },
        ],
      },
    }),
  ];
  writeFileSync(session, lines.join("\n") + "\n");
};

test("analyze cli: scans synthetic projects dir and emits JSON report", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-analyze-"));
  try {
    const projects = join(home, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    synthesize(projects);

    const out = execFileSync(
      process.execPath,
      [CLI, "analyze", "--path", projects, "--json"],
      { env: { ...process.env, HOME: home }, encoding: "utf8" },
    );
    const report = JSON.parse(out);
    assert.equal(report.totals.tool_calls, 2);
    assert.ok(report.totals.observed_tokens > 0);
    // Duplicate should have fired.
    assert.equal(report.totals.duplicate_calls, 1);
    assert.ok(report.by_tool.some((t: { tool: string }) => t.tool === "mcp__fake__big"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("analyze cli: --tokenizer=tiktoken errors out cleanly when missing", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-analyze-"));
  try {
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    let threw = false;
    let stderr = "";
    try {
      execFileSync(
        process.execPath,
        [CLI, "analyze", "--path", join(home, ".claude", "projects"), "--tokenizer=tiktoken"],
        { env: { ...process.env, HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e) {
      threw = true;
      const err = e as { stderr?: string | Buffer };
      stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8") ?? "";
    }
    assert.equal(threw, true);
    assert.match(stderr, /js-tiktoken not available/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
