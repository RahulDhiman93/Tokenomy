import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listGraphRepos } from "../../src/cli/report-repos.js";
import { legacyGraphRootDir, projectsRegistryPath } from "../../src/core/paths.js";

const withTmpHome = (fn: () => void): void => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-report-repos-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
};

const writeMeta = (graphDir: string, fields: Record<string, unknown>): void => {
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, "meta.json"), JSON.stringify(fields));
  writeFileSync(join(graphDir, "snapshot.json"), "{}");
};

test("listGraphRepos: empty home returns no repos", () => {
  withTmpHome(() => {
    const out = listGraphRepos();
    assert.equal(out.repos.length, 0);
    assert.equal(out.unreadable_count, 0);
  });
});

test("listGraphRepos: home-mode graphs discovered + sorted newest first", () => {
  withTmpHome(() => {
    const root = legacyGraphRootDir();
    writeMeta(join(root, "id-A"), {
      schema_version: 1,
      repo_id: "id-A",
      repo_path: "/repos/a",
      built_at: "2026-05-10T00:00:00.000Z",
      node_count: 100,
      edge_count: 50,
    });
    writeMeta(join(root, "id-B"), {
      schema_version: 1,
      repo_id: "id-B",
      repo_path: "/repos/b",
      built_at: "2026-05-16T00:00:00.000Z",
      node_count: 200,
      edge_count: 100,
    });
    const out = listGraphRepos();
    assert.equal(out.repos.length, 2);
    assert.equal(out.repos[0]!.repoId, "id-B"); // newer first
    assert.equal(out.repos[1]!.repoId, "id-A");
    assert.equal(out.repos[0]!.node_count, 200);
    assert.equal(out.repos[0]!.storage, "home");
  });
});

test("listGraphRepos: unreadable entries counted, not crash", () => {
  withTmpHome(() => {
    const root = legacyGraphRootDir();
    // valid
    writeMeta(join(root, "id-good"), {
      schema_version: 1,
      repo_id: "id-good",
      repo_path: "/repos/good",
      built_at: "2026-05-15T00:00:00.000Z",
      node_count: 1,
      edge_count: 0,
    });
    // unreadable: meta.json is malformed
    mkdirSync(join(root, "id-bad"), { recursive: true });
    writeFileSync(join(root, "id-bad", "meta.json"), "{not-json");
    const out = listGraphRepos();
    assert.equal(out.repos.length, 1);
    assert.equal(out.unreadable_count, 1);
  });
});

test("listGraphRepos: in-repo graphs surface via projects.json registry", () => {
  withTmpHome(() => {
    const repoRoot = mkdtempSync(join(tmpdir(), "tokenomy-rr-repo-"));
    try {
      writeMeta(join(repoRoot, ".tokenomy-graph"), {
        schema_version: 1,
        repo_id: "registered-1",
        repo_path: repoRoot,
        built_at: "2026-05-17T00:00:00.000Z",
        node_count: 42,
        edge_count: 21,
      });
      // Seed the registry with one entry pointing at repoRoot.
      const regPath = projectsRegistryPath();
      mkdirSync(join(regPath, ".."), { recursive: true });
      writeFileSync(
        regPath,
        JSON.stringify({ repoId: "registered-1", repoRoot }) + "\n",
      );
      const out = listGraphRepos();
      assert.equal(out.repos.length, 1);
      assert.equal(out.repos[0]!.storage, "in-repo");
      assert.equal(out.repos[0]!.repoId, "registered-1");
      assert.equal(out.repos[0]!.node_count, 42);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

test("listGraphRepos: integrity_ok reflects current build vs last quarantine (codex round 12 P2)", () => {
  withTmpHome(() => {
    const root = legacyGraphRootDir();
    // Quarantine AFTER the build → integrity_ok false
    const dirBad = join(root, "id-quarantine");
    writeMeta(dirBad, {
      schema_version: 1,
      repo_id: "id-quarantine",
      repo_path: "/repos/q",
      built_at: "2026-05-15T00:00:00.000Z",
      node_count: 1,
      edge_count: 0,
    });
    writeFileSync(
      join(dirBad, ".integrity.json"),
      JSON.stringify({
        verified: 5,
        mismatched: 1,
        quarantined_total: 1,
        last_quarantine_at: "2026-05-16T00:00:00.000Z",
      }),
    );
    // Rebuild AFTER the quarantine → integrity_ok true even though
    // mismatched > 0 in cumulative counter
    const dirOk = join(root, "id-recovered");
    writeMeta(dirOk, {
      schema_version: 1,
      repo_id: "id-recovered",
      repo_path: "/repos/r",
      built_at: "2026-05-17T00:00:00.000Z",
      node_count: 1,
      edge_count: 0,
    });
    writeFileSync(
      join(dirOk, ".integrity.json"),
      JSON.stringify({
        verified: 5,
        mismatched: 1,
        quarantined_total: 1,
        last_quarantine_at: "2026-05-16T00:00:00.000Z",
      }),
    );
    const out = listGraphRepos();
    const bad = out.repos.find((r) => r.repoId === "id-quarantine");
    const ok = out.repos.find((r) => r.repoId === "id-recovered");
    assert.equal(bad?.integrity_ok, false);
    assert.equal(ok?.integrity_ok, true);
  });
});
