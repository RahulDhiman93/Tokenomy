import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
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
    // PreToolUse matcher must cover Read (file clamp) + Bash (input
    // bounder) + Write / Edit (OSS-nudge and redact-pre). Uses regex
    // alternation so one entry serves all four tool names.
    const preMatcher = after1.hooks.PreToolUse[0].matcher as string;
    assert.match(preMatcher, /Read/);
    assert.match(preMatcher, /Bash/);
    assert.match(preMatcher, /Write/);
    assert.match(preMatcher, /Edit/);

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

test("init: stages package.json {type:module} alongside the hook", () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".claude"), { recursive: true });
    runInit({});
    const pkgPath = join(h.home, ".tokenomy", "bin", "package.json");
    assert.ok(existsSync(pkgPath), `expected staged package.json at ${pkgPath}`);
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8"));
    // Without {"type":"module"} here Node parses the ESM-built dist/ as
    // CommonJS and the first `import` throws → hook exits 1 under the
    // doctor's smoke test.
    assert.equal(parsed.type, "module");
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

test("init --graph-path registers tokenomy-graph in ~/.claude.json and uninstall removes it", () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".claude"), { recursive: true });
    const repo = join(h.home, "repo");
    mkdirSync(repo, { recursive: true });

    runInit({ graphPath: repo });
    // Claude Code 2.1+ reads mcpServers from ~/.claude.json, not
    // ~/.claude/settings.json. The hooks still go to settings.json.
    const claudeJsonPath = join(h.home, ".claude.json");
    assert.ok(existsSync(claudeJsonPath), "expected ~/.claude.json to exist");
    const claudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    assert.deepEqual(claudeJson.mcpServers["tokenomy-graph"], {
      type: "stdio",
      command: "tokenomy",
      args: ["graph", "serve", "--path", resolve(repo)],
      env: {},
    });
    // Hooks should still be in settings.json.
    const settings = JSON.parse(readFileSync(claudeSettingsPath(), "utf8"));
    assert.ok(settings.hooks?.PreToolUse);
    // And settings.json should NOT have an mcpServers entry under our name
    // (we stopped writing there in the Phase 5 fix).
    assert.equal(settings.mcpServers?.["tokenomy-graph"], undefined);

    runUninstall({ backup: false });
    const afterClaudeJson = JSON.parse(readFileSync(claudeJsonPath, "utf8"));
    assert.equal(afterClaudeJson.mcpServers, undefined);
  } finally {
    h.restore();
  }
});

test("init --agent codex removes tokenomy-graph MCP and keeps Codex hooks", () => {
  const h = setupHome();
  const prevPath = process.env["PATH"];
  try {
    const bin = join(h.home, "bin");
    const repo = join(h.home, "repo");
    const log = join(h.home, "codex-args.log");
    mkdirSync(bin, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const codex = join(bin, "codex");
    writeFileSync(
      codex,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`,
    );
    chmodSync(codex, 0o755);
    process.env["PATH"] = `${bin}:${prevPath ?? ""}`;

    const result = runInit({ agent: "codex", graphPath: repo, backup: false });
    assert.equal(result.agentResults.length, 1);
    assert.equal(result.agentResults[0]?.agent, "codex");
    assert.equal(result.agentResults[0]?.installed, true);
    assert.match(result.agentResults[0]?.detail ?? "", /graph MCP skipped/);

    const calls = readFileSync(log, "utf8");
    assert.match(calls, /mcp remove tokenomy-graph/);
    assert.doesNotMatch(calls, /mcp add tokenomy-graph/);

    const hooks = JSON.parse(readFileSync(join(h.home, ".codex", "hooks.json"), "utf8"));
    assert.equal(hooks.hooks.SessionStart[0].hooks[0].command, result.hookPath);
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, result.hookPath);
  } finally {
    if (prevPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = prevPath;
    h.restore();
  }
});

test("init --agent codex without graph path does not report graph server path", () => {
  const h = setupHome();
  const prevPath = process.env["PATH"];
  try {
    const bin = join(h.home, "bin");
    const log = join(h.home, "codex-args.log");
    mkdirSync(bin, { recursive: true });
    const codex = join(bin, "codex");
    writeFileSync(
      codex,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`,
    );
    chmodSync(codex, 0o755);
    process.env["PATH"] = `${bin}:${prevPath ?? ""}`;

    const result = runInit({ agent: "codex", backup: false });
    assert.equal(result.graphServerPath, null);
    assert.equal(result.agentResults[0]?.agent, "codex");
    assert.equal(result.agentResults[0]?.installed, true);
    assert.equal(existsSync(join(h.home, ".codex", "hooks.json")), true);
  } finally {
    if (prevPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = prevPath;
    h.restore();
  }
});
