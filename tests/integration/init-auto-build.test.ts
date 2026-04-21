import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { graphSnapshotPath } from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";

const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "dist/cli/entry.js");
const FIXTURE = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "tests/fixtures/graph-fixture-repo",
);

const runCli = async (
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
  if (!existsSync(CLI)) throw new Error(`CLI not built: ${CLI}. Run 'npm run build' first.`);
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  const [code] = (await once(child, "exit")) as [number | null];
  return {
    code,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
  };
};

const setup = (): { home: string; repo: string; restore: () => void } => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-init-build-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-init-build-repo-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), "{}");
  cpSync(FIXTURE, repo, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  return {
    home,
    repo,
    restore: () => {
      if (prev === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prev;
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
};

test("init --graph-path: auto-builds the graph; snapshot written + summary in stdout", async () => {
  const s = setup();
  try {
    const env = { ...process.env, HOME: s.home };
    const result = await runCli(["init", `--graph-path=${s.repo}`], env);
    assert.equal(result.code, 0, result.stderr);

    // Output should include a build: line with node/edge counts.
    assert.match(
      result.stdout,
      /build:\s+\d+ nodes \/ \d+ edges in \d+ms/,
      `expected build summary in stdout; got:\n${result.stdout}`,
    );

    // Snapshot file should exist on disk for the fixture repo.
    const { repoId } = resolveRepoId(s.repo);
    assert.equal(existsSync(graphSnapshotPath(repoId)), true);
  } finally {
    s.restore();
  }
});

test("init --graph-path --no-build: MCP registered but no graph built", async () => {
  const s = setup();
  try {
    const env = { ...process.env, HOME: s.home };
    const result = await runCli(["init", `--graph-path=${s.repo}`, "--no-build"], env);
    assert.equal(result.code, 0, result.stderr);

    // graph: line still appears (MCP registration succeeded) but no build: line.
    assert.match(result.stdout, /graph:\s+tokenomy-graph/);
    assert.doesNotMatch(result.stdout, /build:\s+/);

    const { repoId } = resolveRepoId(s.repo);
    assert.equal(existsSync(graphSnapshotPath(repoId)), false);
  } finally {
    s.restore();
  }
});

test("init without --graph-path: no auto-build attempted", async () => {
  const s = setup();
  try {
    const env = { ...process.env, HOME: s.home };
    const result = await runCli(["init"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /graph:\s+tokenomy-graph/);
    assert.doesNotMatch(result.stdout, /build:\s+/);
  } finally {
    s.restore();
  }
});
