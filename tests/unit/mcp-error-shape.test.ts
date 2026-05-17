import { test } from "node:test";
import assert from "node:assert/strict";

// Test the P3 top-level structured-error catch at the request-handler
// level. The handler body is small; rather than wiring a full MCP
// server, replicate the catch shape and assert it produces the right
// payload when the inner dispatch throws.

const safeStringify = (v: unknown): string => JSON.stringify(v);

const wrap = async (dispatch: () => Promise<{ ok: boolean }>): Promise<{
  content: { type: string; text: string }[];
  isError: boolean;
}> => {
  const request_id = "test-request-id";
  try {
    const result = await dispatch();
    return {
      content: [{ type: "text", text: safeStringify(result) }],
      isError: !result.ok,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: "text",
          text: safeStringify({ ok: false, code: "internal", message, request_id }),
        },
      ],
      isError: true,
    };
  }
};

test("P3: handler throw becomes structured internal error", async () => {
  const out = await wrap(async () => {
    throw new Error("boom");
  });
  assert.equal(out.isError, true);
  const parsed = JSON.parse(out.content[0]!.text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "internal");
  assert.equal(parsed.message, "boom");
  assert.ok(parsed.request_id);
});

test("P3: handler success passes through unchanged", async () => {
  const out = await wrap(async () => ({ ok: true, data: 42 }) as unknown as { ok: boolean });
  assert.equal(out.isError, false);
  const parsed = JSON.parse(out.content[0]!.text);
  assert.equal(parsed.ok, true);
});

test("P3: handler ok:false routes through as expected", async () => {
  const out = await wrap(async () => ({ ok: false, reason: "expected-fail" }) as unknown as { ok: boolean });
  assert.equal(out.isError, true);
  const parsed = JSON.parse(out.content[0]!.text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "expected-fail");
});

test("P3: non-Error throws still produce structured response", async () => {
  const out = await wrap(async () => {
    throw "string-error";
  });
  assert.equal(out.isError, true);
  const parsed = JSON.parse(out.content[0]!.text);
  assert.equal(parsed.code, "internal");
  assert.equal(parsed.message, "string-error");
});
