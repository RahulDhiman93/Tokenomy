import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("graph status cli: reports stale files after fixture edit", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-graph-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-graph-repo-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    cpSync(FIXTURE, repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    const env = { ...process.env, HOME: home };

    const built = await runCli(["graph", "build", `--path=${repo}`], env);
    assert.equal(built.code, 0, built.stderr);

    writeFileSync(join(repo, "src", "foo.ts"), "import baz from \"./baz\";\nexport const foo = () => baz() + 1;\n");

    const status = await runCli(["graph", "status", `--path=${repo}`], env);
    assert.equal(status.code, 0, status.stderr);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.stale, true);
    assert.deepEqual(parsed.stale_files, ["src/foo.ts"]);
    assert.equal(typeof parsed.data.repo_id, "string");
    assert.equal(typeof parsed.data.built_at, "string");
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
