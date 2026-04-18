import { test } from "node:test";
import assert from "node:assert/strict";
import { QueryCache } from "../../src/mcp/query-cache.js";

test("QueryCache: key is stable under arg reordering", () => {
  const c = new QueryCache();
  const k1 = c.key("get_minimal_context", { depth: 1, target: { file: "a.ts" } }, "v1");
  const k2 = c.key("get_minimal_context", { target: { file: "a.ts" }, depth: 1 }, "v1");
  assert.equal(k1, k2);
});

test("QueryCache: version change invalidates", () => {
  const c = new QueryCache();
  const k1 = c.key("get_minimal_context", { file: "a.ts" }, "v1");
  const k2 = c.key("get_minimal_context", { file: "a.ts" }, "v2");
  assert.notEqual(k1, k2);
});

test("QueryCache: get/set round-trip", () => {
  const c = new QueryCache();
  const k = c.key("get_minimal_context", { a: 1 }, "v1");
  c.set(k, { ok: true, data: { x: 1 } });
  assert.deepEqual(c.get(k), { ok: true, data: { x: 1 } });
});

test("QueryCache: LRU evicts oldest", () => {
  const c = new QueryCache(3);
  const keys = [0, 1, 2, 3].map((i) => c.key("t", { i }, "v1"));
  c.set(keys[0]!, { i: 0 });
  c.set(keys[1]!, { i: 1 });
  c.set(keys[2]!, { i: 2 });
  assert.equal(c.size, 3);
  c.set(keys[3]!, { i: 3 });
  assert.equal(c.size, 3);
  // keys[0] should be evicted
  assert.equal(c.get(keys[0]!), undefined);
  assert.deepEqual(c.get(keys[3]!), { i: 3 });
});

test("QueryCache: get touches entry (moves to MRU)", () => {
  const c = new QueryCache(2);
  const k1 = c.key("t", { i: 1 }, "v");
  const k2 = c.key("t", { i: 2 }, "v");
  const k3 = c.key("t", { i: 3 }, "v");
  c.set(k1, 1);
  c.set(k2, 2);
  // Touch k1 so k2 becomes the LRU.
  c.get(k1);
  c.set(k3, 3);
  // k2 should be evicted, k1 still present.
  assert.equal(c.get(k2), undefined);
  assert.equal(c.get(k1), 1);
});

test("QueryCache: invalidate clears everything", () => {
  const c = new QueryCache();
  c.set("a", 1);
  c.invalidate();
  assert.equal(c.size, 0);
  assert.equal(c.get("a"), undefined);
});
