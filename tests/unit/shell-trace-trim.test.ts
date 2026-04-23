import { test } from "node:test";
import assert from "node:assert/strict";
import { shellTraceRule, trimShellTraceText } from "../../src/rules/shell-trace.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";

const nodeTrace = `FAIL src/foo.test.ts
  should work
AssertionError: expected 1 to equal 2
expected: 1
actual: 2
    at testOne (/app/src/foo.test.ts:10:3)
    at callA (/app/src/a.ts:1:1)
    at callB (/app/src/b.ts:1:1)
    at callC (/app/src/c.ts:1:1)
    at callD (/app/src/d.ts:1:1)
    at callE (/app/src/e.ts:1:1)
    at callF (/app/src/f.ts:1:1)
    at callG (/app/src/g.ts:1:1)
1 failed, 47 passed`;

test("trimShellTraceText preserves assertion, test name, and summary", () => {
  const out = trimShellTraceText(nodeTrace, { keepHead: 3, keepTail: 2, minFrames: 6 });
  assert.ok(out.framesElided > 0);
  assert.ok(out.text.includes("should work"));
  assert.ok(out.text.includes("expected: 1\nactual: 2"));
  assert.ok(out.text.includes("1 failed, 47 passed"));
  assert.match(out.text, /elided \d+ middle stack frames/);
});

test("trimShellTraceText skips tsc compiler output", () => {
  const tsc = `src/index.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.`;
  const out = trimShellTraceText(tsc, { keepHead: 3, keepTail: 2, minFrames: 6 });
  assert.equal(out.framesElided, 0);
  assert.equal(out.text, tsc);
});

test("shellTraceRule trims Bash MCP-style text responses", () => {
  const result = shellTraceRule(
    "Bash",
    { content: [{ type: "text", text: nodeTrace }] },
    { ...DEFAULT_CONFIG, aggression: "balanced" },
  );
  assert.equal(result.kind, "trim");
  if (result.kind === "trim") {
    const text = result.output.content?.[0]?.type === "text" ? result.output.content[0].text : "";
    assert.ok(text.includes("AssertionError"));
    assert.ok(text.includes("1 failed, 47 passed"));
    assert.ok(result.bytesOut < result.bytesIn);
  }
});

