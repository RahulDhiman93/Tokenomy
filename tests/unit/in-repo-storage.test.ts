import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendGitignoreLine } from "../../src/util/gitignore.js";
import {
  listProjects,
  pruneMissingProjects,
  registerProject,
  rewriteRegistry,
} from "../../src/util/projects-registry.js";
import { migrateAll, tryMigrateOne } from "../../src/util/migrate-storage.js";
import {
  graphDir,
  graphMetaPath,
  graphSnapshotPath,
  legacyGraphRootDir,
  legacyRavenRootDir,
  ravenRepoDir,
} from "../../src/core/paths.js";
import { runGraphMigrate } from "../../src/cli/graph-migrate.js";

const withHome = async <T>(fn: (home: string) => T | Promise<T>): Promise<T> => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-in-repo-storage-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// gitignore.ts
// ---------------------------------------------------------------------------

test("appendGitignoreLine: creates file when missing", async () => {
  await withHome(async (home) => {
    const path = join(home, "repo", ".gitignore");
    const added = appendGitignoreLine(path, ".tokenomy-graph/");
    assert.equal(added, true);
    assert.match(readFileSync(path, "utf8"), /^\.tokenomy-graph\/\n$/);
  });
});

test("appendGitignoreLine: skips when line already present", async () => {
  await withHome(async (home) => {
    const path = join(home, ".gitignore");
    mkdirSync(home, { recursive: true });
    writeFileSync(path, "node_modules\n.tokenomy-graph/\n");
    const added = appendGitignoreLine(path, ".tokenomy-graph/");
    assert.equal(added, false);
  });
});

test("appendGitignoreLine: trailing-slash variant treated as equivalent", async () => {
  await withHome(async (home) => {
    const path = join(home, ".gitignore");
    writeFileSync(path, ".tokenomy-graph\n");
    const added = appendGitignoreLine(path, ".tokenomy-graph/");
    assert.equal(added, false);
  });
});

test("appendGitignoreLine: adds newline before appending when file lacks one", async () => {
  await withHome(async (home) => {
    const path = join(home, ".gitignore");
    writeFileSync(path, "node_modules");
    appendGitignoreLine(path, ".tokenomy-graph/");
    assert.equal(readFileSync(path, "utf8"), "node_modules\n.tokenomy-graph/\n");
  });
});

// ---------------------------------------------------------------------------
// projects-registry.ts
// ---------------------------------------------------------------------------

test("registry: register + list + dedupe latest-wins", async () => {
  await withHome(async () => {
    registerProject({ repoRoot: "/r1", repoId: "rid1", registered_at: "2026-05-01T00:00:00Z" });
    registerProject({
      repoRoot: "/r1",
      repoId: "rid1",
      registered_at: "2026-05-02T00:00:00Z",
      last_built_at: "2026-05-02T00:00:00Z",
      raven_enabled: true,
    });
    registerProject({ repoRoot: "/r2", repoId: "rid2", registered_at: "2026-05-03T00:00:00Z" });
    const projects = listProjects();
    assert.equal(projects.length, 2);
    const r1 = projects.find((p) => p.repoRoot === "/r1");
    assert.ok(r1);
    assert.equal(r1!.raven_enabled, true);
    assert.equal(r1!.last_built_at, "2026-05-02T00:00:00Z");
  });
});

test("registry: pruneMissingProjects flags non-existent repoRoots + rewriteRegistry compacts", async () => {
  await withHome(async () => {
    const real = mkdtempSync(join(tmpdir(), "tokenomy-prune-real-"));
    try {
      registerProject({ repoRoot: real, repoId: "real" });
      registerProject({ repoRoot: "/tmp/does-not-exist-9999", repoId: "missing" });
      const { kept, removed } = pruneMissingProjects();
      assert.equal(kept.length, 1);
      assert.equal(removed.length, 1);
      assert.equal(kept[0]!.repoRoot, real);
      rewriteRegistry(kept);
      const after = listProjects();
      assert.equal(after.length, 1);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});

test("registry: empty file returns empty list, malformed lines skipped", async () => {
  await withHome(async () => {
    assert.deepEqual(listProjects(), []);
  });
});

// ---------------------------------------------------------------------------
// migrate-storage.ts
// ---------------------------------------------------------------------------

test("tryMigrateOne: moves legacy graph into <repoRoot>/.tokenomy-graph/", async () => {
  await withHome(async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "tokenomy-migrate-repo-"));
    try {
      const identity = { repoId: "rid-migrate-1", repoPath };
      // Seed legacy.
      const legacyDir = join(legacyGraphRootDir(), identity.repoId);
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "meta.json"), '{"x":1}');
      const result = tryMigrateOne("graph", identity);
      assert.equal(result.status, "moved");
      assert.equal(existsSync(graphDir(identity)), true);
      assert.equal(existsSync(join(repoPath, ".tokenomy-graph", "meta.json")), true);
      assert.equal(existsSync(legacyDir), false);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

test("tryMigrateOne: skipped-no-src when legacy dir absent", async () => {
  await withHome(async () => {
    const identity = { repoId: "rid-migrate-none", repoPath: "/tmp/does-not-matter" };
    const result = tryMigrateOne("graph", identity);
    assert.equal(result.status, "skipped-no-src");
  });
});

test("tryMigrateOne: skipped-dst-exists when in-repo already has data", async () => {
  await withHome(async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "tokenomy-migrate-dst-"));
    try {
      const identity = { repoId: "rid-migrate-dst", repoPath };
      // Seed both legacy + destination.
      const legacyDir = join(legacyGraphRootDir(), identity.repoId);
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "meta.json"), '{"a":1}');
      mkdirSync(join(repoPath, ".tokenomy-graph"), { recursive: true });
      const result = tryMigrateOne("graph", identity);
      assert.equal(result.status, "skipped-dst-exists");
      assert.equal(existsSync(legacyDir), true);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

test("tryMigrateOne: raven moves legacy ravenRepoDir into <repoRoot>/.tokenomy-raven/", async () => {
  await withHome(async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "tokenomy-migrate-raven-"));
    try {
      const identity = { repoId: "rid-raven", repoPath };
      const legacyDir = join(legacyRavenRootDir(), identity.repoId, "packets");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "p.json"), "{}");
      const result = tryMigrateOne("raven", identity);
      assert.equal(result.status, "moved");
      assert.equal(existsSync(ravenRepoDir(identity)), true);
      assert.equal(existsSync(join(repoPath, ".tokenomy-raven", "packets", "p.json")), true);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

test("migrateAll: dry-run + apply walk registry", async () => {
  await withHome(async () => {
    const repoA = mkdtempSync(join(tmpdir(), "tokenomy-migrate-A-"));
    const repoB = mkdtempSync(join(tmpdir(), "tokenomy-migrate-B-"));
    try {
      const idA = { repoId: "rid-A", repoPath: repoA };
      const idB = { repoId: "rid-B", repoPath: repoB };
      registerProject({ repoRoot: idA.repoPath, repoId: idA.repoId });
      registerProject({ repoRoot: idB.repoPath, repoId: idB.repoId });
      // Seed legacy for repoA only.
      mkdirSync(join(legacyGraphRootDir(), idA.repoId), { recursive: true });
      writeFileSync(join(legacyGraphRootDir(), idA.repoId, "meta.json"), "{}");

      const dry = migrateAll("graph", false);
      assert.equal(dry.length, 2);
      assert.ok(dry.some((r) => r.status === "moved" && r.from.includes("rid-A")));
      assert.ok(dry.some((r) => r.status === "skipped-no-src" && r.from.includes("rid-B")));
      // Dry-run must not move yet.
      assert.equal(existsSync(graphDir(idA)), false);

      const applied = migrateAll("graph", true);
      assert.ok(applied.some((r) => r.status === "moved"));
      assert.equal(existsSync(graphDir(idA)), true);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// cli/graph-migrate.ts
// ---------------------------------------------------------------------------

test("runGraphMigrate: no projects → prints helpful message + returns 0", async () => {
  await withHome(async () => {
    let buf = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      buf += typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runGraphMigrate({ apply: false });
      assert.equal(code, 0);
      assert.match(buf, /No projects registered/);
    } finally {
      process.stdout.write = orig;
    }
  });
});

test("runGraphMigrate: with projects, dry-run prints plan; apply moves", async () => {
  await withHome(async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "tokenomy-migrate-cli-"));
    try {
      const identity = { repoId: "rid-cli", repoPath };
      registerProject({ repoRoot: identity.repoPath, repoId: identity.repoId });
      mkdirSync(join(legacyGraphRootDir(), identity.repoId), { recursive: true });
      writeFileSync(join(legacyGraphRootDir(), identity.repoId, "meta.json"), "{}");

      let buf = "";
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((c: unknown) => {
        buf += typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8");
        return true;
      }) as typeof process.stdout.write;
      try {
        const dry = await runGraphMigrate({ apply: false });
        assert.equal(dry, 0);
        assert.match(buf, /Would migrate/);
        // Apply
        buf = "";
        const applied = await runGraphMigrate({ apply: true });
        assert.equal(applied, 0);
        assert.match(buf, /Migrated/);
        assert.equal(existsSync(graphDir(identity)), true);
      } finally {
        process.stdout.write = orig;
      }
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// migrate-storage temp-staging fallback (codex round 1 P1)
// ---------------------------------------------------------------------------

test("moveDir: cross-fs fallback uses temp sibling rename (never partial dst)", async () => {
  await withHome(async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "tokenomy-migrate-temp-"));
    try {
      const identity = { repoId: "rid-temp", repoPath };
      // Seed legacy with nested data.
      const legacyDir = join(legacyGraphRootDir(), identity.repoId);
      mkdirSync(join(legacyDir, "sub"), { recursive: true });
      writeFileSync(join(legacyDir, "meta.json"), '{"a":1}');
      writeFileSync(join(legacyDir, "sub", "build.jsonl"), "{}");
      const result = tryMigrateOne("graph", identity);
      assert.equal(result.status, "moved");
      // Destination has full structure; no `.migrating-*` siblings linger.
      const parent = join(repoPath);
      const lingering = readFileSync(join(repoPath, ".tokenomy-graph", "meta.json"), "utf8");
      assert.equal(lingering, '{"a":1}');
      void parent;
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// end-to-end: buildGraph auto-migrates + .gitignore patches + registry
// ---------------------------------------------------------------------------

test("raven migrate: prints message + 0 when no projects, walks registry when present", async () => {
  await withHome(async () => {
    const { runRaven } = await import("../../src/cli/raven.js");
    let buf = "";
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: unknown) => {
      buf += typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      const code = await runRaven(["migrate"]);
      assert.equal(code, 0);
      assert.match(buf, /No projects/);
    } finally {
      process.stdout.write = orig;
    }
  });
});

test("graph purge: cwd-scoped default removes only this repo's .tokenomy-graph/", async () => {
  await withHome(async () => {
    const repo = mkdtempSync(join(tmpdir(), "tokenomy-purge-cwd-"));
    try {
      mkdirSync(join(repo, ".tokenomy-graph"), { recursive: true });
      writeFileSync(join(repo, ".tokenomy-graph", "snapshot.json"), "{}");
      const { runGraphPurge } = await import("../../src/cli/graph-purge.js");
      let buf = "";
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((c: unknown) => {
        buf += typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8");
        return true;
      }) as typeof process.stdout.write;
      try {
        await runGraphPurge({ cwd: repo });
      } finally {
        process.stdout.write = orig;
      }
      assert.equal(existsSync(join(repo, ".tokenomy-graph")), false);
      assert.match(buf, /scope.*repo/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("graph purge --all: walks registry + drops legacy root", async () => {
  await withHome(async (home) => {
    const repoA = mkdtempSync(join(tmpdir(), "tokenomy-purge-all-A-"));
    const repoB = mkdtempSync(join(tmpdir(), "tokenomy-purge-all-B-"));
    try {
      mkdirSync(join(repoA, ".tokenomy-graph"), { recursive: true });
      mkdirSync(join(repoB, ".tokenomy-graph"), { recursive: true });
      writeFileSync(join(repoA, ".tokenomy-graph", "snapshot.json"), "{}");
      writeFileSync(join(repoB, ".tokenomy-graph", "snapshot.json"), "{}");
      registerProject({ repoRoot: repoA, repoId: "A" });
      registerProject({ repoRoot: repoB, repoId: "B" });
      // Seed legacy root too.
      mkdirSync(join(home, ".tokenomy", "graphs", "legacy-x"), { recursive: true });
      const { runGraphPurge } = await import("../../src/cli/graph-purge.js");
      let buf = "";
      const orig = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((c: unknown) => {
        buf += typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("utf8");
        return true;
      }) as typeof process.stdout.write;
      try {
        await runGraphPurge({ cwd: repoA, all: true });
      } finally {
        process.stdout.write = orig;
      }
      assert.equal(existsSync(join(repoA, ".tokenomy-graph")), false);
      assert.equal(existsSync(join(repoB, ".tokenomy-graph")), false);
      assert.equal(existsSync(join(home, ".tokenomy", "graphs")), false);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});

test("collectRavenStats: per-project location respected via loadConfig", async () => {
  await withHome(async (home) => {
    const repo = mkdtempSync(join(tmpdir(), "tokenomy-stats-loc-"));
    try {
      // Set per-project config to legacy "home" mode.
      mkdirSync(join(home, ".tokenomy"), { recursive: true });
      writeFileSync(
        join(home, ".tokenomy", "config.json"),
        JSON.stringify({ raven: { location: "home" } }),
      );
      // Legacy storage under ~/.tokenomy/raven/<repoId>/.
      const legacyDir = join(home, ".tokenomy", "raven", "loc-repo", "packets");
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(join(legacyDir, "p.json"), "{}");
      registerProject({ repoRoot: repo, repoId: "loc-repo", raven_enabled: true });
      const { collectRavenStats } = await import("../../src/raven/stats.js");
      const stats = collectRavenStats(true);
      // Per-project loadConfig picks up location:"home" so this repo's legacy
      // dir IS counted; no double-count under legacy fallback.
      assert.equal(stats.repos, 1);
      assert.equal(stats.packets, 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("diagnose: --all-repos uses registry-backed Raven tally", async () => {
  await withHome(async () => {
    const repoA = mkdtempSync(join(tmpdir(), "tokenomy-diag-all-A-"));
    const repoB = mkdtempSync(join(tmpdir(), "tokenomy-diag-all-B-"));
    try {
      for (const r of [repoA, repoB]) {
        mkdirSync(join(r, ".tokenomy-raven", "packets"), { recursive: true });
        writeFileSync(join(r, ".tokenomy-raven", "packets", "p.json"), "{}");
      }
      registerProject({ repoRoot: repoA, repoId: "diag-A", raven_enabled: true });
      registerProject({ repoRoot: repoB, repoId: "diag-B", raven_enabled: true });
      const { buildDiagnoseReport } = await import("../../src/cli/diagnose.js");
      const report = await buildDiagnoseReport({ allRepos: true });
      assert.equal(report.raven.scope, "all-repos");
      assert.equal(report.raven.repos, 2);
      assert.equal(report.raven.packets, 2);
    } finally {
      rmSync(repoA, { recursive: true, force: true });
      rmSync(repoB, { recursive: true, force: true });
    }
  });
});

test("buildGraph: in-repo storage + auto-migrate + .gitignore patch + registry", async () => {
  await withHome(async () => {
    const repoPath = mkdtempSync(join(tmpdir(), "tokenomy-e2e-inrepo-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: repoPath, stdio: "ignore" });
      writeFileSync(join(repoPath, "a.ts"), "export const a = 1;\n");
      execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
      const { buildGraph } = await import("../../src/graph/build.js");
      const { DEFAULT_CONFIG } = await import("../../src/core/config.js");
      const { resolveRepoId } = await import("../../src/graph/repo-id.js");
      const r = await buildGraph({ cwd: repoPath, config: DEFAULT_CONFIG });
      assert.equal(r.ok, true);
      // Snapshot lives in-repo.
      const identity = resolveRepoId(repoPath);
      assert.equal(existsSync(graphSnapshotPath(identity)), true);
      assert.equal(existsSync(graphMetaPath(identity)), true);
      // .gitignore patched.
      const gi = readFileSync(join(repoPath, ".gitignore"), "utf8");
      assert.match(gi, /\.tokenomy-graph\//);
      // Project registered.
      const projects = listProjects();
      assert.ok(projects.some((p) => p.repoRoot === identity.repoPath));
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
