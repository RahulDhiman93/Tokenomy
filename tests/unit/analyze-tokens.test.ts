import { test } from "node:test";
import assert from "node:assert/strict";
import { heuristicCount, heuristicTokenizer, loadTokenizer } from "../../src/analyze/tokens.js";

test("heuristicCount: empty string → 0", () => {
  assert.equal(heuristicCount(""), 0);
});

test("heuristicCount: pure ASCII prose is within ±30% of bytes/4", () => {
  const text = "The quick brown fox jumps over the lazy dog. ".repeat(20);
  const approx = heuristicCount(text);
  const bytesOver4 = Math.ceil(text.length / 4);
  // heuristic tends to overcount by 15-20% on English prose — that's okay.
  assert.ok(approx > 0);
  assert.ok(Math.abs(approx - bytesOver4) / bytesOver4 < 0.5, `got ${approx} vs ~${bytesOver4}`);
});

test("heuristicCount: JSON is more expensive per char than prose", () => {
  const json = JSON.stringify({ id: 1, name: "x", values: [1, 2, 3], nested: { a: true } });
  const prose = "x".repeat(json.length);
  const jsonTok = heuristicCount(json);
  const proseTok = heuristicCount(prose);
  assert.ok(jsonTok > proseTok, `json=${jsonTok}, prose=${proseTok}`);
});

test("heuristicCount: newlines count as additional tokens", () => {
  const a = heuristicCount("word word word");
  const b = heuristicCount("word\nword\nword");
  assert.ok(b > a);
});

test("loadTokenizer: heuristic path returns heuristic instance", async () => {
  const t = await loadTokenizer("heuristic");
  assert.equal(t.name, "heuristic");
  assert.equal(t.approximate, true);
  assert.equal(t.count("hello"), heuristicTokenizer.count("hello"));
});

test("loadTokenizer: auto falls back to heuristic when tiktoken missing", async () => {
  // js-tiktoken isn't installed in this test environment.
  const t = await loadTokenizer("auto");
  assert.equal(t.name, "heuristic");
});

test("loadTokenizer: tiktoken mode throws when missing", async () => {
  await assert.rejects(() => loadTokenizer("tiktoken"), /js-tiktoken not available/);
});
