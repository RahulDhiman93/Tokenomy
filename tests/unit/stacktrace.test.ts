import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseStacktrace, looksLikeStacktrace } from "../../src/rules/stacktrace.js";

const nodeTrace = `Error: Cannot read properties of undefined (reading 'foo')
    at doThing (/app/src/a.ts:12:3)
    at inner (/app/src/b.ts:44:7)
    at level3 (/app/src/c.ts:21:1)
    at level4 (/app/src/d.ts:11:2)
    at level5 (/app/src/e.ts:19:5)
    at level6 (/app/src/f.ts:31:7)
    at level7 (/app/src/g.ts:40:9)
    at level8 (/app/src/h.ts:51:11)
    at level9 (/app/src/i.ts:62:13)
    at level10 (/app/src/j.ts:73:15)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

test("looksLikeStacktrace: detects error-headed trace", () => {
  assert.equal(looksLikeStacktrace(nodeTrace), true);
});

test("looksLikeStacktrace: detects long frame runs", () => {
  const frames = Array.from({ length: 8 }, (_, i) => `    at fn${i} (/a/${i}.js:1:1)`).join("\n");
  assert.equal(looksLikeStacktrace(frames), true);
});

test("looksLikeStacktrace: plain text returns false", () => {
  assert.equal(looksLikeStacktrace("hello\nworld\nno stack here"), false);
});

test("collapseStacktrace: keeps error header + first + last 3 frames", () => {
  const r = collapseStacktrace(nodeTrace);
  assert.equal(r.ok, true);
  assert.ok(r.trimmed!.includes("Cannot read properties"));
  assert.ok(r.trimmed!.includes("doThing"));
  assert.ok(r.trimmed!.includes("processTicksAndRejections"));
  assert.match(r.trimmed!, /elided \d+ middle stack frames/);
  assert.ok(r.bytesOut < r.bytesIn);
});

test("collapseStacktrace: passes through non-traces", () => {
  const r = collapseStacktrace("Just a log line, nothing fancy.");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-stacktrace");
});

test("collapseStacktrace: passes through short traces", () => {
  const short = `Error: boom\n    at foo (/a.ts:1:1)\n    at bar (/b.ts:1:1)`;
  const r = collapseStacktrace(short);
  // Head+tail would be >= total; reject.
  assert.equal(r.ok, false);
});

test("collapseStacktrace: python traceback", () => {
  const py = `Traceback (most recent call last):
  File "/app/a.py", line 12, in foo
    x = bar()
  File "/app/b.py", line 24, in bar
    y = baz()
  File "/app/c.py", line 30, in baz
    z = qux()
  File "/app/d.py", line 40, in qux
    return fail()
  File "/app/e.py", line 50, in fail
    raise RuntimeError("boom")
  File "/app/f.py", line 60, in entry
    return fail()
  File "/app/g.py", line 70, in entry2
    return fail()
RuntimeError: boom`;
  assert.equal(looksLikeStacktrace(py), true);
  const r = collapseStacktrace(py);
  assert.equal(r.ok, true);
  assert.ok(r.trimmed!.includes("Traceback"));
  assert.match(r.trimmed!, /elided/);
});
