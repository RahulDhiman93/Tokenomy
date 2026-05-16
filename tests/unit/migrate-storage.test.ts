import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryMigrateOne, migrateAll } from "../../src/util/migrate-storage.js";
import {
  graphDir,
  legacyGraphRootDir,
  legacyRavenRootDir,
  ravenRepoDir,
} from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";

const withTmpHomeAndRepo = (fn: (home: string, repo: string) => void): void => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-migrate-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-migrate-repo-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    fn(home, repo);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
};

test("tryMigrateOne: graph — skipped-no-src when legacy dir missing", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    const result = tryMigrateOne("graph", identity);
    assert.equal(result.status, "skipped-no-src");
    assert.equal(result.kind, "graph");
  });
});

test("tryMigrateOne: graph — skipped-dst-exists when target already populated", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    // Create both legacy and in-repo dirs.
    const legacy = join(legacyGraphRootDir(), identity.repoId);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "meta.json"), "{}");
    const inRepo = graphDir(identity, { location: "in-repo" });
    mkdirSync(inRepo, { recursive: true });
    writeFileSync(join(inRepo, "marker"), "x");
    const result = tryMigrateOne("graph", identity);
    assert.equal(result.status, "skipped-dst-exists");
    // Legacy preserved; new dir intact.
    assert.equal(existsSync(legacy), true);
    assert.equal(existsSync(join(inRepo, "marker")), true);
  });
});

test("tryMigrateOne: graph — moves legacy → in-repo when src exists + dst absent", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    const legacy = join(legacyGraphRootDir(), identity.repoId);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "meta.json"), '{"x":1}');
    const result = tryMigrateOne("graph", identity);
    assert.equal(result.status, "moved", JSON.stringify(result));
    const dst = graphDir(identity, { location: "in-repo" });
    assert.equal(existsSync(join(dst, "meta.json")), true);
    // Legacy gone after move.
    assert.equal(existsSync(legacy), false);
  });
});

test("tryMigrateOne: raven — skipped-no-src when legacy raven dir missing", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    const result = tryMigrateOne("raven", identity);
    assert.equal(result.status, "skipped-no-src");
  });
});

test("tryMigrateOne: raven — moves legacy raven dir into in-repo", () => {
  withTmpHomeAndRepo((_home, repo) => {
    const identity = resolveRepoId(repo);
    const legacy = join(legacyRavenRootDir(), identity.repoId);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "packet.json"), "{}");
    const result = tryMigrateOne("raven", identity);
    assert.equal(result.status, "moved");
    const dst = ravenRepoDir(identity, { location: "in-repo" });
    assert.equal(existsSync(join(dst, "packet.json")), true);
  });
});

test("migrateAll: no-op when no projects registered + no legacy dirs", () => {
  withTmpHomeAndRepo((_home, _repo) => {
    const results = migrateAll();
    assert.deepEqual(results, []);
  });
});
