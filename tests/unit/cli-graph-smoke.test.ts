import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGraph } from "../../src/cli/graph.js";

// In-process smoke tests for `tokenomy graph <build|status|purge>` plus the
// dispatcher in cli/graph.ts. We spin up a tiny TS project under an isolated
// HOME so build artifacts land in our tmp dir, not the host cache.

const captureOut = async <T>(
  fn: () => Promise<T> | T,
): Promise<{ value: T; out: string; err: string }> => {
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((c: Uint8Array | string) => {
    out += typeof c === "string" ? c : Buffer.from(c).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: Uint8Array | string) => {
    err += typeof c === "string" ? c : Buffer.from(c).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    const value = await fn();
    return { value, out, err };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
};

const setupRepo = (): { repo: string; home: string; cleanup: () => void } => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-cli-graph-home-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-cli-graph-repo-"));
  spawnSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "T"], { cwd: repo, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@x.test"], { cwd: repo, stdio: "ignore" });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src", "b.ts"), "import { a } from './a.js';\nexport const b = a + 1;\n");
  spawnSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  spawnSync(
    "git",
    [
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@x.test",
      "commit",
      "-m",
      "init",
    ],
    { cwd: repo, stdio: "ignore" },
  );
  return {
    repo,
    home,
    cleanup: () => {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
};

test("runGraph build → status → purge round-trip on a tiny repo", async () => {
  const { repo, cleanup } = setupRepo();
  try {
    const build = await captureOut(() => runGraph(["build", "--path", repo]));
    assert.equal(build.value, 0, `build failed: ${build.err}`);
    assert.match(build.out, /"ok":\s*true/);

    const status = await captureOut(() => runGraph(["status", "--path", repo]));
    assert.equal(status.value, 0);
    assert.match(status.out, /"ok":\s*true/);

    // Purge the repo-scoped graph.
    const purge = await captureOut(() => runGraph(["purge", "--path", repo]));
    assert.equal(purge.value, 0);
    assert.match(purge.out, /"purged":\s*true/);

    // After purge, status should report graph-not-built.
    const statusAfter = await captureOut(() => runGraph(["status", "--path", repo]));
    assert.match(statusAfter.out, /"ok":\s*false|graph-not-built/);
  } finally {
    cleanup();
  }
});

test("runGraph build with --exclude=glob accepts repeated flag", async () => {
  const { repo, cleanup } = setupRepo();
  try {
    const r = await captureOut(() =>
      runGraph(["build", "--path", repo, "--exclude=src/b.ts", "--exclude", "*.spec.ts"]),
    );
    assert.equal(r.value, 0);
    assert.match(r.out, /"ok":\s*true/);
  } finally {
    cleanup();
  }
});

test("runGraph purge --all wipes the entire graph root", async () => {
  const { repo, home, cleanup } = setupRepo();
  try {
    await captureOut(() => runGraph(["build", "--path", repo]));
    const r = await captureOut(() => runGraph(["purge", "--all"]));
    assert.equal(r.value, 0);
    assert.match(r.out, /"scope":\s*"all"/);
    // The graphs root dir should now be gone.
    assert.equal(existsSync(join(home, ".tokenomy", "graphs")), false);
  } finally {
    cleanup();
  }
});

test("runGraph: missing subcommand prints help + exit 1", async () => {
  const r = await captureOut(() => runGraph([]));
  assert.equal(r.value, 1);
  assert.match(r.err, /Usage:/);
});

test("runGraph: unknown subcommand prints error + exit 1", async () => {
  const r = await captureOut(() => runGraph(["bogus"]));
  assert.equal(r.value, 1);
  assert.match(r.err, /Unknown graph command/);
});
