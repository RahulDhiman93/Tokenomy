import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { graphMetaPath } from "../../src/core/paths.js";
import { preDispatch } from "../../src/hook/pre-dispatch.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";

test("preDispatch: appends graph-aware hint when a local graph snapshot exists", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-pre-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-pre-repo-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const largeFile = join(repo, "large.ts");
    writeFileSync(largeFile, "x".repeat(60_000));

    const { repoId } = resolveRepoId(repo);
    const metaPath = graphMetaPath(repoId);
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(metaPath, "{}\n");

    const output = preDispatch(
      {
        session_id: "s",
        transcript_path: "/tmp/t",
        cwd: repo,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: largeFile },
      },
      {
        ...DEFAULT_CONFIG,
        log_path: join(home, ".tokenomy", "savings.jsonl"),
      },
    );

    assert.ok(output);
    assert.match(
      output!.hookSpecificOutput.additionalContext ?? "",
      /tokenomy-graph/,
    );
    assert.match(
      output!.hookSpecificOutput.additionalContext ?? "",
      /clamped Read/,
    );
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("preDispatch: Read with relative file_path resolves against input.cwd", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-pre-rel-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-pre-rel-repo-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    // 60KB file in the "project" dir — above the conservative 80KB default.
    writeFileSync(join(repo, "big.json"), "x".repeat(90_000));

    const output = preDispatch(
      {
        session_id: "s",
        transcript_path: "/tmp/t",
        cwd: repo, // Claude Code's CWD, NOT the hook subprocess's.
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        // Relative path — the regression we're protecting against. Before
        // the fix, statSync() ran against process.cwd() of the hook
        // subprocess, which had no 'big.json', so the rule returned
        // "stat-failed" → passthrough → no clamp.
        tool_input: { file_path: "big.json" },
      },
      {
        ...DEFAULT_CONFIG,
        log_path: join(home, ".tokenomy", "savings.jsonl"),
      },
    );
    assert.ok(output, "expected a clamp output, got null (passthrough regression)");
    const updated = output!.hookSpecificOutput.updatedInput as Record<string, unknown>;
    assert.equal(typeof updated["limit"], "number");
    // Resolved to absolute so Claude Code reads the right file.
    assert.ok((updated["file_path"] as string).startsWith("/"));
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test("preDispatch: Bash verbose command → bounded updatedInput", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-pre-bash-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const output = preDispatch(
      {
        session_id: "s",
        transcript_path: "/tmp/t",
        cwd: home,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git log" },
      },
      {
        ...DEFAULT_CONFIG,
        log_path: join(home, ".tokenomy", "savings.jsonl"),
      },
    );
    assert.ok(output);
    const cmd = (output!.hookSpecificOutput.updatedInput as Record<string, unknown>)[
      "command"
    ] as string;
    assert.ok(cmd.startsWith("set -o pipefail; "));
    assert.ok(cmd.includes("git log"));
    assert.ok(/\| awk 'NR<=\d+'$/.test(cmd));
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("preDispatch: Bash short command → null", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-pre-bash-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const output = preDispatch(
      {
        session_id: "s",
        transcript_path: "/tmp/t",
        cwd: home,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      },
      {
        ...DEFAULT_CONFIG,
        log_path: join(home, ".tokenomy", "savings.jsonl"),
      },
    );
    assert.equal(output, null);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
});
