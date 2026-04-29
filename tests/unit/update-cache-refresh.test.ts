import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  shouldRefreshUpdateCache,
  updateCacheAgeMs,
} from "../../src/cli/statusline.js";

const writeCache = (path: string, body: unknown): void => {
  writeFileSync(path, JSON.stringify(body), "utf8");
};

test("shouldRefreshUpdateCache: returns true when cache is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-update-cache-"));
  try {
    assert.equal(shouldRefreshUpdateCache(join(dir, "no-such-cache.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldRefreshUpdateCache: returns false when cache age < 3h", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-update-cache-"));
  const path = join(dir, "cache.json");
  try {
    const now = Date.now();
    writeCache(path, { remote: "0.1.3", fetched_at: new Date(now - 60 * 60 * 1000).toISOString() });
    assert.equal(shouldRefreshUpdateCache(path, now), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldRefreshUpdateCache: returns true when cache age > 3h", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-update-cache-"));
  const path = join(dir, "cache.json");
  try {
    const now = Date.now();
    writeCache(path, {
      remote: "0.1.3",
      fetched_at: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
    });
    assert.equal(shouldRefreshUpdateCache(path, now), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldRefreshUpdateCache: missing fetched_at field → refresh true", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-update-cache-"));
  const path = join(dir, "cache.json");
  try {
    writeCache(path, { remote: "0.1.3" });
    assert.equal(shouldRefreshUpdateCache(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shouldRefreshUpdateCache: malformed JSON → refresh true", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-update-cache-"));
  const path = join(dir, "cache.json");
  try {
    writeFileSync(path, "{not json", "utf8");
    assert.equal(shouldRefreshUpdateCache(path), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateCacheAgeMs: returns null on missing file", () => {
  assert.equal(updateCacheAgeMs("/nonexistent/cache.json"), null);
});

test("updateCacheAgeMs: returns positive ms when fetched_at is in the past", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-update-cache-"));
  const path = join(dir, "cache.json");
  try {
    const now = Date.now();
    writeCache(path, {
      remote: "0.1.3",
      fetched_at: new Date(now - 7 * 60 * 1000).toISOString(),
    });
    const age = updateCacheAgeMs(path, now);
    assert.ok(age !== null);
    assert.ok(age! >= 7 * 60 * 1000 - 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
