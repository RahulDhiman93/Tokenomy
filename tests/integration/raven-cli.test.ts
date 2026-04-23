import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "src/cli/entry.ts");

const runCli = (argv: string[], env: NodeJS.ProcessEnv) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", CLI, ...argv], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

test("tokenomy raven enable: refuses to turn on when Codex CLI is missing", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-raven-cli-home-"));
  const path = mkdtempSync(join(tmpdir(), "tokenomy-raven-cli-path-"));
  try {
    const r = runCli(["raven", "enable"], { HOME: home, PATH: path });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Raven cannot be enabled/);
    assert.match(r.stderr, /codex cli not found/);
    assert.equal(r.stdout, "");
    assert.equal(existsSync(join(home, ".tokenomy", "config.json")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(path, { recursive: true, force: true });
  }
});

test("tokenomy raven disable: writes only the Raven disabled switch", () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-raven-cli-home-"));
  try {
    const r = runCli(["raven", "disable"], { HOME: home });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Raven disabled/);
    const cfg = JSON.parse(readFileSync(join(home, ".tokenomy", "config.json"), "utf8"));
    assert.equal(cfg.raven.enabled, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
