import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runInit } from "../../src/cli/init.js";
import { runUninstall } from "../../src/cli/uninstall.js";
import {
  claudeSettingsPath,
  hookBinaryPath,
  manifestPath,
} from "../../src/core/paths.js";

const setupHome = (): { home: string; restore: () => void } => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-init-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  return {
    home,
    restore: () => {
      if (prev === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prev;
      rmSync(home, { recursive: true, force: true });
    },
  };
};

const SEED_SETTINGS = {
  model: "opus[1m]",
  enabledPlugins: { "code-review@claude-plugins-official": true },
  effortLevel: "xhigh",
};

test("init → idempotent → uninstall leaves unrelated settings untouched", () => {
  const h = setupHome();
  try {
    // seed real-ish settings.json
    mkdirSync(join(h.home, ".claude"), { recursive: true });
    writeFileSync(claudeSettingsPath(), JSON.stringify(SEED_SETTINGS, null, 2));

    const result = runInit({});
    assert.equal(result.hookPath, hookBinaryPath());
    assert.ok(existsSync(result.hookPath));
    assert.ok(existsSync(manifestPath()));

    const after1 = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    assert.equal(after1.model, "opus[1m]");
    assert.equal(after1.effortLevel, "xhigh");
    assert.equal(after1.hooks.PostToolUse.length, 1);
    assert.equal(after1.hooks.PreToolUse.length, 1);

    // idempotent
    runInit({});
    const after2 = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    assert.equal(after2.hooks.PostToolUse.length, 1);
    assert.equal(after2.hooks.PreToolUse.length, 1);

    // uninstall
    runUninstall({ backup: false });
    const afterUninstall = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    assert.equal(afterUninstall.model, "opus[1m]");
    assert.equal(afterUninstall.effortLevel, "xhigh");
    assert.equal(afterUninstall.hooks, undefined);
  } finally {
    h.restore();
  }
});

test("init: creates config.json if missing; preserves existing on re-init", () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".claude"), { recursive: true });
    runInit({});
    const cfgPath = join(h.home, ".tokenomy", "config.json");
    assert.ok(existsSync(cfgPath));
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.aggression, "conservative");

    // hand-edit aggression, re-init without --aggression: should not overwrite
    cfg.aggression = "aggressive";
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    runInit({});
    const cfgAfter = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(cfgAfter.aggression, "aggressive");
  } finally {
    h.restore();
  }
});

test("init --aggression updates existing config", () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".claude"), { recursive: true });
    runInit({});
    runInit({ aggression: "balanced" });
    const cfg = JSON.parse(
      readFileSync(join(h.home, ".tokenomy", "config.json"), "utf8"),
    );
    assert.equal(cfg.aggression, "balanced");
  } finally {
    h.restore();
  }
});

test("uninstall --purge removes ~/.tokenomy/", () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".claude"), { recursive: true });
    runInit({});
    runUninstall({ purge: true });
    assert.equal(existsSync(join(h.home, ".tokenomy")), false);
  } finally {
    h.restore();
  }
});

test("init --graph-path registers tokenomy-graph and uninstall removes it", () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".claude"), { recursive: true });
    const repo = join(h.home, "repo");
    mkdirSync(repo, { recursive: true });

    runInit({ graphPath: repo });
    const settings = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    assert.deepEqual(settings.mcpServers["tokenomy-graph"], {
      command: "tokenomy",
      args: ["graph", "serve", "--path", resolve(repo)],
    });

    runUninstall({ backup: false });
    const after = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    assert.equal(after.mcpServers, undefined);
  } finally {
    h.restore();
  }
});
