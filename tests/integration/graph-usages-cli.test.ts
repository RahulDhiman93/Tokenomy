import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const home = mkdtempSync(join(tmpdir(), "tokenomy-usages-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-usages-repo-"));
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

test("graph query usages cli: returns JSON payload matching findUsages", async () => {
  const setup = setupFixtureRepo();
  try {
    const env = { ...process.env, HOME: setup.home };
    const build = await runCli(["graph", "build", `--path=${setup.repo}`], env);
    assert.equal(build.code, 0, build.stderr);

    const result = await runCli(
      [
        "graph",
        "query",
        "usages",
        `--path=${setup.repo}`,
        "--file=src/foo.ts",
      ],
      env,
    );
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.focal.kind, "file");
    assert.equal(typeof parsed.data.summary, "string");
    assert.ok(Array.isArray(parsed.data.call_sites));
  } finally {
    setup.restore();
  }
});

test("graph query usages cli: unknown --file surfaces target-not-found", async () => {
  const setup = setupFixtureRepo();
  try {
    const env = { ...process.env, HOME: setup.home };
    await runCli(["graph", "build", `--path=${setup.repo}`], env);
    const result = await runCli(
      [
        "graph",
        "query",
        "usages",
        `--path=${setup.repo}`,
        "--file=does/not/exist.ts",
      ],
      env,
    );
    assert.equal(result.code, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "target-not-found");
  } finally {
    setup.restore();
  }
});

test("graph query (no mode): error hint now mentions usages", async () => {
  const setup = setupFixtureRepo();
  try {
    const env = { ...process.env, HOME: setup.home };
    await runCli(["graph", "build", `--path=${setup.repo}`], env);
    const result = await runCli(
      ["graph", "query", "bogus-mode", `--path=${setup.repo}`],
      env,
    );
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.hint, /usages/);
  } finally {
    setup.restore();
  }
});
