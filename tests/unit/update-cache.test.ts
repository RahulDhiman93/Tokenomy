import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUpdateCache, renderStatusLine } from "../../src/cli/statusline.js";
import { TOKENOMY_VERSION } from "../../src/core/version.js";

const makeTmpCache = (body: unknown): string => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-cache-"));
  const path = join(dir, "update-cache.json");
  writeFileSync(path, JSON.stringify(body), "utf8");
  return path;
};

test("readUpdateCache: returns undefined when file is missing", () => {
  assert.equal(readUpdateCache("/nonexistent/update-cache.json"), undefined);
});

test("readUpdateCache: returns undefined for older remote than installed", () => {
  const path = makeTmpCache({ remote: "0.0.0", fetched_at: new Date().toISOString() });
  try {
    assert.equal(readUpdateCache(path), undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test("readUpdateCache: returns remote when newer than installed", () => {
  const path = makeTmpCache({ remote: "99.0.0", fetched_at: new Date().toISOString() });
  try {
    assert.equal(readUpdateCache(path), "99.0.0");
  } finally {
    rmSync(path, { force: true });
  }
});

test("readUpdateCache: ignores cache older than 14 days", () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const path = makeTmpCache({ remote: "99.0.0", fetched_at: old });
  try {
    assert.equal(readUpdateCache(path), undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test("readUpdateCache: malformed JSON returns undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-cache-"));
  const path = join(dir, "update-cache.json");
  writeFileSync(path, "{not json", "utf8");
  try {
    assert.equal(readUpdateCache(path), undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test("renderStatusLine: appends ↑ when updateAvailable is set", () => {
  const line = renderStatusLine({
    active: true,
    tokensToday: 0,
    updateAvailable: "99.0.0",
  });
  assert.ok(
    line.includes(`v${TOKENOMY_VERSION}↑`),
    `expected up-arrow after version, got: ${line}`,
  );
});

test("renderStatusLine: no arrow when updateAvailable is undefined", () => {
  const line = renderStatusLine({ active: true, tokensToday: 0 });
  assert.ok(!line.includes("↑"), `expected no up-arrow, got: ${line}`);
});
