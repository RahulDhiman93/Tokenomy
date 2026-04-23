import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(
  fileURLToPath(new URL("../..", import.meta.url)),
  "dist/cli/entry.js",
);

const runCli = (argv: string[], env: NodeJS.ProcessEnv) => {
  if (!existsSync(CLI)) throw new Error("CLI not built. Run `npm run build`.");
  const r = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

const withHome = <T>(fn: (home: string) => T): T => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-golem-cli-"));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

test("tokenomy golem status: prints disabled by default", () => {
  withHome((home) => {
    const r = runCli(["golem", "status"], { HOME: home });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Golem: disabled/);
    assert.match(r.stdout, /mode:\s+full/); // default mode even when disabled
  });
});

test("tokenomy golem enable: flips enabled=true, persists to config.json", () => {
  withHome((home) => {
    const r = runCli(["golem", "enable"], { HOME: home });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Golem enabled in FULL mode/);
    const cfg = JSON.parse(readFileSync(join(home, ".tokenomy", "config.json"), "utf8"));
    assert.equal(cfg.golem.enabled, true);
    assert.equal(cfg.golem.mode, "full");
  });
});

test("tokenomy golem enable --mode=lite: persists mode override", () => {
  withHome((home) => {
    const r = runCli(["golem", "enable", "--mode=lite"], { HOME: home });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Golem enabled in LITE mode/);
    const cfg = JSON.parse(readFileSync(join(home, ".tokenomy", "config.json"), "utf8"));
    assert.equal(cfg.golem.mode, "lite");
  });
});

test("tokenomy golem enable --mode=bogus: rejects invalid modes", () => {
  withHome((home) => {
    const r = runCli(["golem", "enable", "--mode=bogus"], { HOME: home });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /invalid mode/);
  });
});

test("tokenomy golem disable: flips enabled=false", () => {
  withHome((home) => {
    runCli(["golem", "enable"], { HOME: home });
    const r = runCli(["golem", "disable"], { HOME: home });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Golem disabled/);
    const cfg = JSON.parse(readFileSync(join(home, ".tokenomy", "config.json"), "utf8"));
    assert.equal(cfg.golem.enabled, false);
  });
});

test("tokenomy golem status (enabled): shows the exact injection text", () => {
  withHome((home) => {
    runCli(["golem", "enable", "--mode=ultra"], { HOME: home });
    const r = runCli(["golem", "status"], { HOME: home });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Golem: ENABLED/);
    assert.match(r.stdout, /mode:\s+ultra/);
    assert.match(r.stdout, /SessionStart injection/);
    assert.match(r.stdout, /ULTRA mode/);
    assert.match(r.stdout, /UserPromptSubmit reminder/);
  });
});

test("tokenomy golem: unknown subcommand → prints usage + non-zero exit", () => {
  withHome((home) => {
    const r = runCli(["golem", "bogus"], { HOME: home });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Usage:/);
  });
});
