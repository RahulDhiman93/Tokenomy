import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupFile } from "../../src/util/backup.js";

const withTmp = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-backup-retention-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("backup retention: 15 backups → prune to 10 newest", () => {
  withTmp((dir) => {
    const target = join(dir, "settings.json");
    writeFileSync(target, "v0\n");
    // Seed 15 fake backups with monotonically increasing mtimes.
    const base = "settings.json.tokenomy-bak-";
    for (let i = 0; i < 15; i++) {
      const path = join(dir, `${base}2026-05-01T00-00-${String(i).padStart(2, "0")}Z`);
      writeFileSync(path, `v${i}\n`);
      const t = new Date(Date.now() - (20 - i) * 60_000);
      utimesSync(path, t, t);
    }
    assert.equal(
      readdirSync(dir).filter((n) => n.startsWith(base)).length,
      15,
    );
    // Trigger one more backup; the prune fires.
    const fresh = backupFile(target);
    assert.ok(fresh);
    const remaining = readdirSync(dir).filter((n) => n.startsWith(base)).length;
    assert.equal(remaining, 10);
    // Newest 10 (including the just-created one) should be present.
    assert.ok(existsSync(fresh!));
  });
});

test("backup retention: under cap → no pruning", () => {
  withTmp((dir) => {
    const target = join(dir, "config.json");
    writeFileSync(target, "x\n");
    const created = backupFile(target);
    assert.ok(created);
    const siblings = readdirSync(dir).filter((n) => n.includes("tokenomy-bak-"));
    assert.equal(siblings.length, 1);
  });
});

test("backup retention: missing source returns null, no prune", () => {
  withTmp((dir) => {
    const out = backupFile(join(dir, "missing.json"));
    assert.equal(out, null);
    assert.equal(readdirSync(dir).length, 0);
  });
});
