import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeTrim } from "../../src/rules/shape-trim.js";

const OPTS = { max_items: 50, max_string_bytes: 200 };

test("shape-trim: top-level homogeneous array of records keeps all rows", () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: String(i),
    name: `Row ${i}`,
    description: "x".repeat(500),
  }));
  const r = shapeTrim(JSON.stringify(rows), OPTS);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!);
  assert.equal(parsed.length, 12);
  assert.equal(parsed[0].id, "0");
  assert.match(parsed[0].description, /\[tokenomy: elided/);
  assert.ok(r.bytesOut! < r.bytesIn!);
  assert.equal(r.shape, "array");
});

test("shape-trim: wrapped {transitions: [...]} detected and preserved", () => {
  const payload = {
    expand: "transitions",
    transitions: Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      name: `T-${i}`,
      hasScreen: false,
      to: { id: String(100 + i), name: `S-${i}`, description: "y".repeat(400) },
    })),
  };
  const r = shapeTrim(JSON.stringify(payload), OPTS);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!);
  assert.equal(parsed.transitions.length, 15);
  assert.equal(parsed.expand, "transitions"); // sibling key preserved
  assert.equal(parsed.transitions[0].id, "0");
  assert.equal(r.shape, "wrapped:transitions");
});

test("shape-trim: mixed array (not homogeneous) bails", () => {
  const mixed = [1, "string", { a: 1 }, null, { b: 2 }];
  const r = shapeTrim(JSON.stringify(mixed), OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-inventory-shape");
});

test("shape-trim: non-JSON text bails", () => {
  const r = shapeTrim("this is not json", OPTS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-json");
});

test("shape-trim: nested arrays inside rows get elided", () => {
  const payload = [
    { id: "A", labels: ["one", "two", "three"], comments: Array(50).fill({ body: "x" }) },
    { id: "B", labels: ["four"], comments: [] },
  ];
  const r = shapeTrim(JSON.stringify(payload), OPTS);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!);
  assert.equal(parsed.length, 2);
  // Nested arrays replaced with an elision marker row count (for non-empty).
  assert.equal(Array.isArray(parsed[0].labels), true);
  assert.match(String(parsed[0].labels[0]), /elided 3 items/);
  assert.match(String(parsed[0].comments[0]), /elided 50 items/);
  // Empty nested arrays stay empty (no marker needed).
  assert.deepEqual(parsed[1].comments, []);
});

test("shape-trim: depth > 2 nested objects collapsed", () => {
  // Bulk up the payload so depth elision produces net savings.
  const payload = Array.from({ length: 5 }, (_, i) => ({
    id: `A${i}`,
    user: {
      name: `Alice-${i}`,
      profile: {
        bio: "nested-bio-" + "x".repeat(100),
        more: { deep: "too-deep-" + "y".repeat(500) },
      },
    },
  }));
  const r = shapeTrim(JSON.stringify(payload), OPTS);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!);
  assert.equal(parsed[0].user.name, "Alice-0");
  // user.profile is depth 2 — it's kept but its children are compacted.
  // user.profile.more is depth 3 — elided.
  assert.equal(typeof parsed[0].user.profile, "object");
  assert.match(String(parsed[0].user.profile.more), /nested object elided/);
});

test("shape-trim: max_items caps row count with marker", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i), name: `r${i}` }));
  const r = shapeTrim(JSON.stringify(rows), { max_items: 10, max_string_bytes: 200 });
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!);
  // 10 rows + 1 marker string
  assert.equal(parsed.length, 11);
  assert.match(String(parsed[10]), /elided 190 rows/);
});

test("shape-trim: small payload that can't be compacted bails with no-savings", () => {
  // Two tiny identical rows — compact form is same size as input.
  const tiny = [{ a: 1 }, { a: 2 }];
  const r = shapeTrim(JSON.stringify(tiny), OPTS);
  // Either ok:false no-savings, or ok:true (if compaction adds nothing). Either
  // way, no grow. Assert no regression.
  if (r.ok) {
    assert.ok(r.bytesOut! <= r.bytesIn!);
  } else {
    assert.equal(r.reason, "no-savings");
  }
});

test("shape-trim: rows with occasional missing fields still homogeneous", () => {
  const rows = [
    { id: "1", name: "A", email: "a@x" },
    { id: "2", name: "B", email: "b@x" },
    { id: "3", name: "C" }, // email missing — still homogeneous (≥80%)
    { id: "4", name: "D", email: "d@x" },
    { id: "5", name: "E", email: "e@x" },
  ];
  // Make it big enough to compact.
  const big = rows.map((r) => ({ ...r, description: "x".repeat(500) }));
  const r = shapeTrim(JSON.stringify(big), OPTS);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!);
  assert.equal(parsed.length, 5);
});
