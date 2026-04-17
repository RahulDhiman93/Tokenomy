import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readManifest,
  writeManifest,
  upsertEntry,
  removeEntryByCommand,
} from "../../src/util/manifest.js";
import { manifestPath } from "../../src/core/paths.js";

const withStubHome = <T>(fn: () => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-mf-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
};

test("manifest: empty when file missing", () => {
  withStubHome(() => {
    const m = readManifest();
    assert.equal(m.version, 1);
    assert.deepEqual(m.entries, []);
  });
});

test("manifest: upsert replaces matching entry; remove by command works", () => {
  withStubHome(() => {
    let m = readManifest();
    m = upsertEntry(m, {
      command_path: "/a",
      settings_path: "/s",
      matcher: "mcp__.*",
      installed_at: "2026-04-17T00:00:00Z",
    });
    m = upsertEntry(m, {
      command_path: "/a",
      settings_path: "/s",
      matcher: "mcp__.*",
      installed_at: "2026-04-17T00:00:01Z",
    });
    writeManifest(m);
    const reloaded = readManifest();
    assert.equal(reloaded.entries.length, 1);
    assert.equal(reloaded.entries[0]!.installed_at, "2026-04-17T00:00:01Z");
    const removed = removeEntryByCommand(reloaded, "/a");
    assert.equal(removed.entries.length, 0);
  });
});

test("manifest: malformed JSON returns empty", () => {
  withStubHome(() => {
    mkdirSync(dirname(manifestPath()), { recursive: true });
    writeFileSync(manifestPath(), "{ not json");
    const m = readManifest();
    assert.equal(m.entries.length, 0);
    assert.ok(existsSync(manifestPath()));
  });
});
