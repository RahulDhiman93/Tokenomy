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
