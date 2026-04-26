import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFeedback } from "../../src/cli/feedback.js";

const withTmpHome = <T>(fn: () => T): T => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-feedback-home-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
};

const captureStdout = <T>(fn: () => T): { value: T; out: string } => {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = "";
  process.stdout.write = ((chunk: Uint8Array | string) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    return { value: fn(), out: buf };
  } finally {
    process.stdout.write = orig;
  }
};

const captureStderr = <T>(fn: () => T): { value: T; err: string } => {
  const orig = process.stderr.write.bind(process.stderr);
  let buf = "";
  process.stderr.write = ((chunk: Uint8Array | string) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: fn(), err: buf };
  } finally {
    process.stderr.write = orig;
  }
};

test("feedback: empty argv prints usage and returns 2", () => {
  const r = captureStderr(() => runFeedback([]));
  assert.equal(r.value, 2);
  assert.match(r.err, /Usage:/);
  assert.match(r.err, /tokenomy feedback/);
});

test("feedback: --print-only writes a prefilled GitHub issue URL and logs locally", () => {
  withTmpHome(() => {
    const r = captureStdout(() =>
      runFeedback(["--print-only", "raven brief is hanging on commit messages with emoji"]),
    );
    assert.equal(r.value, 0);
    assert.match(r.out, /github\.com\/RahulDhiman93\/Tokenomy\/issues\/new/);
    assert.match(r.out, /title=feedback%3A/);
    assert.match(r.out, /labels=feedback/);
    const logPath = join(process.env["HOME"]!, ".tokenomy", "feedback.jsonl");
    assert.ok(existsSync(logPath), "expected ~/.tokenomy/feedback.jsonl to exist");
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    assert.ok(lines.length >= 1);
    const entry = JSON.parse(lines[lines.length - 1]!);
    assert.match(entry.text, /raven brief is hanging/);
    assert.match(entry.title, /^feedback: /);
    assert.match(entry.submitted_via, /^browser$/);
    assert.ok(typeof entry.ts === "string" && entry.ts.length > 0);
  });
});

test("feedback: long text is truncated in the prefilled URL but kept full in the local log", () => {
  withTmpHome(() => {
    const long = "x ".repeat(4000); // ~8000 chars, well above the 6 000 cap
    const r = captureStdout(() => runFeedback(["--print-only", long]));
    assert.equal(r.value, 0);
    // URL body is capped — we should see the truncation marker in the URL.
    assert.match(r.out, /truncated\+by\+tokenomy\+feedback|truncated%20by%20tokenomy%20feedback/);
    const logPath = join(process.env["HOME"]!, ".tokenomy", "feedback.jsonl");
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
    // Local log keeps the full untruncated text.
    assert.equal(entry.text, long.trim());
  });
});

test("feedback: title is built from first line and capped at 60 chars", () => {
  withTmpHome(() => {
    const longLine = "raven packets are not capturing committed-only branches when working tree is clean";
    const r = captureStdout(() => runFeedback(["--print-only", longLine]));
    assert.equal(r.value, 0);
    const logPath = join(process.env["HOME"]!, ".tokenomy", "feedback.jsonl");
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
    // "feedback: " prefix + ≤60 chars of body + ellipsis
    assert.match(entry.title, /^feedback: /);
    assert.ok(entry.title.length <= "feedback: ".length + 61, entry.title);
  });
});

test("feedback: multi-arg invocation joins tokens", () => {
  withTmpHome(() => {
    const r = captureStdout(() =>
      runFeedback(["--print-only", "raven", "brief", "hangs", "on", "emoji"]),
    );
    assert.equal(r.value, 0);
    const logPath = join(process.env["HOME"]!, ".tokenomy", "feedback.jsonl");
    const entry = JSON.parse(readFileSync(logPath, "utf8").trim().split("\n").pop()!);
    assert.equal(entry.text, "raven brief hangs on emoji");
  });
});
