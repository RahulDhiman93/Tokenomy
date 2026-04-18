import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPerfStats } from "../../src/cli/doctor.js";

const withSandbox = (fn: () => void): void => {
  const tmp = mkdtempSync(join(tmpdir(), "tokenomy-perf-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = tmp;
  try {
    fn();
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  }
};

test("readPerfStats: returns null when log is missing", () => {
  withSandbox(() => {
    assert.equal(readPerfStats(10), null);
  });
});

test("readPerfStats: computes p50/p95/max from recent samples", () => {
  withSandbox(() => {
    const dir = join(process.env["HOME"]!, ".tokenomy");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { elapsed_ms: 1 },
      { elapsed_ms: 5 },
      { elapsed_ms: 10 },
      { elapsed_ms: 20 },
      { elapsed_ms: 100 },
      { phase: "no-elapsed" }, // should be ignored
      { elapsed_ms: 50 },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    writeFileSync(join(dir, "debug.jsonl"), lines);
    const s = readPerfStats(100);
    assert.ok(s);
    assert.equal(s!.samples, 6);
    assert.ok(s!.p95_ms >= s!.p50_ms);
    assert.equal(s!.max_ms, 100);
  });
});

test("readPerfStats: honors sampleSize cap", () => {
  withSandbox(() => {
    const dir = join(process.env["HOME"]!, ".tokenomy");
    mkdirSync(dir, { recursive: true });
    const all = Array.from({ length: 20 }, (_, i) => ({ elapsed_ms: i })).map((x) =>
      JSON.stringify(x),
    );
    writeFileSync(join(dir, "debug.jsonl"), all.join("\n"));
    const s = readPerfStats(5);
    assert.ok(s);
    assert.equal(s!.samples, 5);
    // Last 5 are 15..19; max should be 19.
    assert.equal(s!.max_ms, 19);
  });
});
