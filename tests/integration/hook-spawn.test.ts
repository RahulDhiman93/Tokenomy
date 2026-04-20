import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "dist/hook/entry.js",
);

const runHook = async (stdinJson: unknown, env: NodeJS.ProcessEnv = process.env): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> => {
  if (!existsSync(HOOK)) {
    throw new Error(`Hook not built: ${HOOK}. Run 'npm run build' first.`);
  }
  const child = spawn(process.execPath, [HOOK], { stdio: ["pipe", "pipe", "pipe"], env });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => out.push(c));
  child.stderr.on("data", (c: Buffer) => err.push(c));
  child.stdin.end(JSON.stringify(stdinJson));
  const [code] = (await once(child, "exit")) as [number | null];
  return {
    code,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
  };
};

const configureConservativeOff = (home: string): void => {
  mkdirSync(join(home, ".tokenomy"), { recursive: true });
  writeFileSync(
    join(home, ".tokenomy", "config.json"),
    JSON.stringify({
      aggression: "balanced",
      gate: { always_trim_above_bytes: 1000, min_saved_bytes: 100, min_saved_pct: 0.1 },
      mcp: { max_text_bytes: 200, per_block_head: 50, per_block_tail: 20 },
      log_path: join(home, ".tokenomy", "savings.jsonl"),
      disabled_tools: [],
    }),
  );
};

test("hook: passthrough for non-mcp tool", async () => {
  const { code, stdout } = await runHook({
    session_id: "t",
    transcript_path: "/tmp/t",
    cwd: "/tmp",
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls" },
    tool_use_id: "x",
    tool_response: { exit_code: 0, stdout: "a", stderr: "", interrupted: false },
  });
  assert.equal(code, 0);
  assert.equal(stdout, "");
});

test("hook: passthrough for small mcp response", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-it-"));
  try {
    configureConservativeOff(home);
    const env = { ...process.env, HOME: home };
    const { code, stdout } = await runHook(
      {
        session_id: "t",
        transcript_path: "/tmp/t",
        cwd: home,
        permission_mode: "default",
        hook_event_name: "PostToolUse",
        tool_name: "mcp__x__y",
        tool_input: {},
        tool_use_id: "x",
        tool_response: { content: [{ type: "text", text: "short" }] },
      },
      env,
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hook: trims large mcp text, emits hookSpecificOutput, writes savings log", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-it-"));
  try {
    configureConservativeOff(home);
    const env = { ...process.env, HOME: home };
    const big = "A".repeat(5000);
    const { code, stdout } = await runHook(
      {
        session_id: "t-big",
        transcript_path: "/tmp/t",
        cwd: home,
        permission_mode: "default",
        hook_event_name: "PostToolUse",
        tool_name: "mcp__big__search",
        tool_input: {},
        tool_use_id: "x",
        tool_response: {
          content: [
            { type: "image", data: "img" },
            { type: "text", text: big },
          ],
          is_error: false,
        },
      },
      env,
    );
    assert.equal(code, 0);
    assert.ok(stdout.length > 0, "expected non-empty stdout");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
    const out = parsed.hookSpecificOutput.updatedMCPToolOutput;
    assert.equal(out.is_error, false);
    // image preserved at its original relative position
    assert.equal(out.content[0].type, "image");
    // hint footer present
    const last = out.content[out.content.length - 1];
    assert.match(last.text, /response trimmed/);
    // savings log written
    const { readFileSync } = await import("node:fs");
    const log = readFileSync(join(home, ".tokenomy", "savings.jsonl"), "utf8");
    assert.match(log, /"tool":"mcp__big__search"/);
    assert.match(log, /"session_id":"t-big"/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hook: PreToolUse Bash verbose command → bounded updatedInput", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-it-bash-"));
  try {
    const env = { ...process.env, HOME: home };
    const { code, stdout } = await runHook(
      {
        session_id: "t-bash",
        transcript_path: "/tmp/t",
        cwd: home,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git log" },
      },
      env,
    );
    assert.equal(code, 0);
    assert.ok(stdout.length > 0, "expected non-empty stdout");
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    const cmd = parsed.hookSpecificOutput.updatedInput.command as string;
    assert.ok(cmd.startsWith("set -o pipefail; "));
    assert.match(cmd, /\| awk 'NR<=\d+'$/);
    assert.match(parsed.hookSpecificOutput.additionalContext ?? "", /bounded git-log/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hook: PreToolUse Bash already-bounded command → passthrough", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-it-bash-"));
  try {
    const env = { ...process.env, HOME: home };
    const { code, stdout } = await runHook(
      {
        session_id: "t-bash-skip",
        transcript_path: "/tmp/t",
        cwd: home,
        permission_mode: "default",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git log -n 5" },
      },
      env,
    );
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("hook: malformed stdin → exit 0 with empty stdout", async () => {
  const child = spawn(process.execPath, [HOOK], { stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => out.push(c));
  child.stdin.end("{ not valid json");
  const [code] = (await once(child, "exit")) as [number | null];
  assert.equal(code, 0);
  assert.equal(Buffer.concat(out).toString("utf8"), "");
});
