import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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

const setupFixtureRepo = (): { home: string; repo: string; restore: () => void } => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-graph-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-graph-repo-"));
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

test("graph build cli: writes snapshot/meta and reuses fresh graph on second build", async () => {
  const setup = setupFixtureRepo();
  try {
    const env = { ...process.env, HOME: setup.home };
    const first = await runCli(["graph", "build", `--path=${setup.repo}`], env);
    assert.equal(first.code, 0, first.stderr);
    const parsed1 = JSON.parse(first.stdout);
    assert.equal(parsed1.ok, true);
    assert.equal(parsed1.data.built, true);
    assert.ok(parsed1.data.node_count >= 25);
    assert.ok(parsed1.data.edge_count >= 23);

    const { repoId } = resolveRepoId(setup.repo);
    const snapshot = graphSnapshotPath(repoId);
    assert.equal(existsSync(snapshot), true);
    const before = readFileSync(snapshot, "utf8");

    const second = await runCli(["graph", "build", `--path=${setup.repo}`], env);
    assert.equal(second.code, 0, second.stderr);
    const parsed2 = JSON.parse(second.stdout);
    assert.equal(parsed2.ok, true);
    assert.equal(parsed2.data.built, false);
    assert.ok(parsed2.data.duration_ms <= parsed1.data.duration_ms);
    assert.equal(readFileSync(snapshot, "utf8"), before);
  } finally {
    setup.restore();
  }
});
