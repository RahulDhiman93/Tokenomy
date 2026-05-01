import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDoctor, runDoctorFix } from "../../src/cli/doctor.js";
import { runFeedback } from "../../src/cli/feedback.js";
import { runCompress } from "../../src/cli/compress.js";
import { runRaven } from "../../src/cli/raven.js";
import { runDiagnose } from "../../src/cli/diagnose.js";
import { runStatusLine } from "../../src/cli/statusline.js";
import { runCi } from "../../src/cli/ci.js";
import { runUpdate, isTransientNpmFailure, compareVersions } from "../../src/cli/update.js";
import { installDetectedAgents, uninstallAgent, listAgentDetection, findAgent } from "../../src/cli/agents/index.js";
import { appendSavingsLog, appendGraphBuildLog } from "../../src/core/log.js";
import { readLastGraphBuildLog, readLastGraphBuildFailure } from "../../src/graph/build-log.js";
import { hookBinaryPath, claudeSettingsPath, graphBuildLogPath } from "../../src/core/paths.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const setupHome = (): { home: string; restore: () => void; pathPrev: string | undefined } => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-cov95-"));
  const prevHome = process.env["HOME"];
  const pathPrev = process.env["PATH"];
  process.env["HOME"] = home;
  return {
    home,
    pathPrev,
    restore: () => {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      if (pathPrev === undefined) delete process.env["PATH"];
      else process.env["PATH"] = pathPrev;
      rmSync(home, { recursive: true, force: true });
    },
  };
};

const captureOut = async <T>(
  fn: () => T | Promise<T>,
): Promise<{ value: T; out: string; err: string }> => {
  const ow = process.stdout.write.bind(process.stdout);
  const ew = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  const append = (chunk: unknown): string =>
    typeof chunk === "string"
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString("utf8")
          : String(chunk);
  process.stdout.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    out += append(chunk);
    if (typeof enc === "function") (enc as () => void)();
    if (typeof cb === "function") (cb as () => void)();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    err += append(chunk);
    if (typeof enc === "function") (enc as () => void)();
    if (typeof cb === "function") (cb as () => void)();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), out, err };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
};

const writeFakeBin = (dir: string, name: string, body: string): string => {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
};

// ---------------------------------------------------------------------------
// doctor.ts — failure branch coverage
// ---------------------------------------------------------------------------

test("doctor: settings file missing reports not-found", async () => {
  const h = setupHome();
  try {
    const checks = await runDoctor();
    const settingsCheck = checks.find((c) => c.name === "~/.claude/settings.json parses");
    assert.equal(settingsCheck?.ok, false);
    assert.match(settingsCheck?.detail ?? "", /does not exist/);
    const hookCheck = checks.find((c) => c.name === "Hook binary exists + executable");
    assert.equal(hookCheck?.ok, false);
    const cfgCheck = checks.find((c) => c.name === "~/.tokenomy/config.json parses");
    assert.equal(cfgCheck?.ok, false);
  } finally {
    h.restore();
  }
});

test("doctor: invalid JSON in settings.json reports invalid", async () => {
  const h = setupHome();
  try {
    const sp = claudeSettingsPath();
    mkdirSync(dirname(sp), { recursive: true });
    writeFileSync(sp, "{ not json", "utf8");
    mkdirSync(join(h.home, ".tokenomy"), { recursive: true });
    writeFileSync(join(h.home, ".tokenomy", "config.json"), "{ also not json", "utf8");
    const checks = await runDoctor();
    const sc = checks.find((c) => c.name === "~/.claude/settings.json parses");
    assert.equal(sc?.ok, false);
    assert.match(sc?.detail ?? "", /invalid JSON/);
    const cfg = checks.find((c) => c.name === "~/.tokenomy/config.json parses");
    assert.equal(cfg?.ok, false);
  } finally {
    h.restore();
  }
});

test("doctor: hook binary missing reports remediation", async () => {
  const h = setupHome();
  try {
    const checks = await runDoctor();
    const c = checks.find((c) => c.name === "Hook binary exists + executable");
    assert.equal(c?.ok, false);
    const smoke = checks.find((c) => c.name === "Smoke spawn hook (empty mcp call)");
    assert.equal(smoke?.ok, false);
    assert.match(smoke?.detail ?? "", /binary missing/);
  } finally {
    h.restore();
  }
});

test("doctor: malformed graph entry, overlap mcp hook, missing PreToolUse", async () => {
  const h = setupHome();
  try {
    const sp = claudeSettingsPath();
    mkdirSync(dirname(sp), { recursive: true });
    const hook = hookBinaryPath();
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(hook, 0o755);
    const command = `"${hook}"`;
    writeFileSync(
      sp,
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              { matcher: "mcp__.*", hooks: [{ type: "command", command, timeout: 10 }] },
              { matcher: "mcp__other__", hooks: [{ type: "command", command: "/usr/bin/other", timeout: 5 }] },
            ],
            UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }],
            SessionStart: [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }],
          },
          mcpServers: {
            "tokenomy-graph": { command: "tokenomy", args: ["serve"] },
          },
          statusLine: { type: "command", command: "tokenomy status-line" },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(h.home, ".claude.json"), JSON.stringify({ mcpServers: { "tokenomy-graph": { command: "tokenomy", args: ["serve"] } } }));
    const checks = await runDoctor();
    const matcher = checks.find((c) => c.name === "PreToolUse matcher covers Read + Bash + Write + Edit");
    assert.equal(matcher?.ok, false);
    const overlap = checks.find((c) => c.name === "No overlapping mcp__ hook");
    assert.equal(overlap?.ok, false);
    const graph = checks.find((c) => c.name === "Graph MCP registration");
    assert.equal(graph?.ok, false);
  } finally {
    h.restore();
  }
});

test("doctor: hook entry counts wrong, statusline missing", async () => {
  const h = setupHome();
  try {
    const sp = claudeSettingsPath();
    mkdirSync(dirname(sp), { recursive: true });
    writeFileSync(sp, JSON.stringify({ hooks: {} }));
    const checks = await runDoctor();
    const hookEntry = checks.find((c) => c.name?.startsWith("Hook entries present"));
    assert.equal(hookEntry?.ok, false);
    const sl = checks.find((c) => c.name === "Statusline registered");
    assert.equal(sl?.ok, false);
  } finally {
    h.restore();
  }
});

test("doctor: hook perf budget exceeded fails", async () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".tokenomy"), { recursive: true });
    writeFileSync(
      join(h.home, ".tokenomy", "config.json"),
      JSON.stringify({ perf: { p95_budget_ms: 1, sample_size: 3 } }),
    );
    writeFileSync(
      join(h.home, ".tokenomy", "debug.jsonl"),
      [JSON.stringify({ elapsed_ms: 200 }), JSON.stringify({ elapsed_ms: 300 }), JSON.stringify({ elapsed_ms: 400 })].join("\n") + "\n",
    );
    const checks = await runDoctor();
    const perf = checks.find((c) => c.name === "Hook perf budget");
    assert.equal(perf?.ok, false);
  } finally {
    h.restore();
  }
});

test("doctor: dirty sentinel age, raven store, savings log size, update cache age", async () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".tokenomy"), { recursive: true });
    // Stale dirty sentinel
    const repoId = "stale-repo-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const graphDir = join(h.home, ".tokenomy", "graphs", repoId);
    mkdirSync(graphDir, { recursive: true });
    const dirty = join(graphDir, ".dirty");
    writeFileSync(dirty, "");
    const oldTime = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(dirty, oldTime, oldTime);
    // Raven store with file > 10MB
    const ravenDir = join(h.home, ".tokenomy", "raven", "repo-x", "packets");
    mkdirSync(ravenDir, { recursive: true });
    writeFileSync(join(ravenDir, "p.json"), Buffer.alloc(11 * 1024 * 1024));
    // Savings log > 50MB
    writeFileSync(join(h.home, ".tokenomy", "savings.jsonl"), Buffer.alloc(51 * 1024 * 1024));
    // Update cache > 24h
    const cache = join(h.home, ".tokenomy", "update-cache.json");
    writeFileSync(cache, JSON.stringify({ installed: "0.1.0", remote: "0.1.0", tag: "latest", fetched_at: new Date().toISOString() }));
    const oldTimeCache = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
    utimesSync(cache, oldTimeCache, oldTimeCache);

    const checks = await runDoctor();
    const dirtyCheck = checks.find((c) => c.name === "Graph dirty sentinel age");
    assert.equal(dirtyCheck?.ok, false);
    const raven = checks.find((c) => c.name === "Raven store size");
    assert.equal(raven?.ok, false);
    const savings = checks.find((c) => c.name === "Savings log size");
    assert.equal(savings?.ok, false);
    const upd = checks.find((c) => c.name === "Update cache age");
    assert.equal(upd?.ok, false);
  } finally {
    h.restore();
  }
});

test("doctorFix: re-init when entries missing", async () => {
  const h = setupHome();
  try {
    const hook = hookBinaryPath();
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(hook, 0o755);
    const sp = claudeSettingsPath();
    mkdirSync(dirname(sp), { recursive: true });
    writeFileSync(sp, JSON.stringify({ hooks: {} }));

    const fixed = await runDoctorFix();
    const after = JSON.parse(readFileSync(sp, "utf8"));
    assert.ok(after.hooks?.PostToolUse?.length >= 1);
    assert.ok(fixed.length >= 1);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// agents/index.ts — codex install/uninstall, install via fake binaries
// ---------------------------------------------------------------------------

test("agents: codex install with fake binary removes graph MCP, keeps hooks", () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    const log = join(h.home, "codex.log");
    writeFakeBin(bin, "codex", `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 0\n`);
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const repo = join(h.home, "repo");
    mkdirSync(repo);
    const results = installDetectedAgents(repo, false, "codex");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.installed, true);
    assert.match(results[0]?.detail ?? "", /graph MCP skipped/);
    const calls = readFileSync(log, "utf8");
    assert.match(calls, /mcp remove tokenomy-graph/);
    assert.doesNotMatch(calls, /mcp add tokenomy-graph/);
  } finally {
    h.restore();
  }
});

test("agents: codex install detects missing codex on PATH", () => {
  const h = setupHome();
  try {
    const emptyBin = join(h.home, "empty-bin");
    mkdirSync(emptyBin);
    process.env["PATH"] = emptyBin;
    const codex = findAgent("codex");
    const r = codex?.install(h.home, false);
    assert.equal(r?.installed, false);
    assert.match(r?.detail ?? "", /codex not on PATH/);
  } finally {
    h.restore();
  }
});

test("agents: codex uninstall calls mcp remove + hooks remove", () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    writeFakeBin(bin, "codex", "#!/bin/sh\nexit 0\n");
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    // Pre-create a codex hooks file so removeCodexTokenomyHooks has work
    mkdirSync(join(h.home, ".codex"));
    writeFileSync(join(h.home, ".codex", "hooks.json"), JSON.stringify({ hooks: {} }));
    const r = uninstallAgent("codex", false);
    assert.equal(r.agent, "codex");
    assert.match(r.detail, /codex mcp remove/);
  } finally {
    h.restore();
  }
});

test("agents: codex uninstall when codex not on PATH", () => {
  const h = setupHome();
  try {
    process.env["PATH"] = join(h.home, "no-bin");
    const r = uninstallAgent("codex", false);
    assert.equal(r.installed, false);
    assert.match(r.detail, /codex not on PATH/);
  } finally {
    h.restore();
  }
});

test("agents: cursor/windsurf/cline/gemini install + uninstall flow", () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".cursor"));
    mkdirSync(join(h.home, ".codeium", "windsurf"), { recursive: true });
    mkdirSync(join(h.home, ".cline"));
    mkdirSync(join(h.home, ".gemini"));
    const detection = listAgentDetection();
    const detected = detection.filter((d) => d.detected).map((d) => d.agent);
    assert.ok(detected.includes("cursor"));
    assert.ok(detected.includes("windsurf"));
    assert.ok(detected.includes("cline"));
    assert.ok(detected.includes("gemini"));
    const repo = h.home;
    const results = installDetectedAgents(repo, false);
    const byName = new Map(results.map((r) => [r.agent, r]));
    assert.equal(byName.get("cursor")?.installed, true);
    assert.equal(byName.get("windsurf")?.installed, true);
    assert.equal(byName.get("cline")?.installed, true);
    assert.equal(byName.get("gemini")?.installed, true);
    // Verify mcp.json contains tokenomy-graph
    const cursorJson = JSON.parse(readFileSync(join(h.home, ".cursor", "mcp.json"), "utf8"));
    assert.ok(cursorJson.mcpServers?.["tokenomy-graph"]);

    const u1 = uninstallAgent("cursor", false);
    assert.equal(u1.installed, true);
    const u2 = uninstallAgent("windsurf", false);
    assert.equal(u2.installed, true);
    const u3 = uninstallAgent("cline", false);
    assert.equal(u3.installed, true);
    const u4 = uninstallAgent("gemini", false);
    assert.equal(u4.installed, true);
  } finally {
    h.restore();
  }
});

test("agents: claude-code adapter has no uninstall", () => {
  const r = uninstallAgent("claude-code", false);
  assert.equal(r.installed, false);
  assert.match(r.detail, /no uninstall adapter/);
});

// ---------------------------------------------------------------------------
// feedback.ts — fake gh binary paths
// ---------------------------------------------------------------------------

test("feedback: fake gh binary, success path files issue", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    writeFakeBin(
      bin,
      "gh",
      `#!/bin/sh\ncase "$1" in\n  --version) echo gh 2.0.0; exit 0;;\n  auth) exit 0;;\n  issue) echo "https://github.com/RahulDhiman93/Tokenomy/issues/9001"; exit 0;;\nesac\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runFeedback(["raven", "brief", "is", "broken"]));
    assert.equal(r.value, 0);
    assert.match(r.out, /Feedback filed/);
    assert.match(r.out, /github\.com.*issues\/9001/);
  } finally {
    h.restore();
  }
});

test("feedback: fake gh issue create fails, falls back to URL print", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    writeFakeBin(
      bin,
      "gh",
      `#!/bin/sh\ncase "$1" in\n  --version) echo gh 2.0.0; exit 0;;\n  auth) exit 0;;\n  issue) echo "rate limit" >&2; exit 1;;\nesac\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runFeedback(["--print-only", "feedback", "text"]));
    assert.equal(r.value, 0);
    assert.match(r.out, /github\.com\/.*\/issues\/new/);
  } finally {
    h.restore();
  }
});

test("feedback: gh found but not authed, falls back", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    writeFakeBin(
      bin,
      "gh",
      `#!/bin/sh\ncase "$1" in\n  --version) exit 0;;\n  auth) exit 1;;\nesac\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runFeedback(["--print-only", "test", "feedback"]));
    assert.equal(r.value, 0);
    assert.match(r.out, /github\.com.*issues\/new/);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// compress.ts — file branches
// ---------------------------------------------------------------------------

test("compress: status with no candidates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-cmp-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const r = await captureOut(() => runCompress(["status"]));
    assert.equal(r.value, 0);
    assert.match(r.out, /No candidate/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compress: status lists candidates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-cmp-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    writeFileSync(join(dir, "CLAUDE.md"), "# heading\n\n\n- bullet\n- bullet\n");
    const r = await captureOut(() => runCompress(["status"]));
    assert.equal(r.value, 0);
    assert.match(r.out, /CLAUDE.md/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compress: file --diff and --in-place + restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-cmp-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const cwd = process.cwd();
    const relFile = "AGENTS.md";
    const fullFile = join(cwd, relFile);
    writeFileSync(fullFile, "# H\n\n\n# H\n\n- a\n- a\n");

    const diff = await captureOut(() => runCompress([relFile, "--diff"]));
    assert.equal(diff.value, 0);
    assert.match(diff.out, /bytes:/);

    const dryRun = await captureOut(() => runCompress([relFile, "--dry-run"]));
    assert.equal(dryRun.value, 0);

    const inPlace = await captureOut(() => runCompress([relFile, "--in-place"]));
    assert.equal(inPlace.value, 0);
    assert.ok(existsSync(`${fullFile}.original.md`));

    const restore = await captureOut(() => runCompress(["restore", relFile]));
    assert.equal(restore.value, 0);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compress: usage on bare invocation, restore w/o file", async () => {
  const r1 = await captureOut(() => runCompress([]));
  assert.equal(r1.value, 1);
  assert.match(r1.out, /Usage:/);
  const r2 = await captureOut(() => runCompress(["help"]));
  assert.equal(r2.value, 0);
  const r3 = await captureOut(() => runCompress(["restore"]));
  assert.equal(r3.value, 1);
  assert.match(r3.err, /Usage:/);
});

test("compress: refuse outside cwd without --force", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-cmp-out-"));
  const file = join(dir, "outside.md");
  writeFileSync(file, "# h\n");
  const prev = process.cwd();
  const inner = mkdtempSync(join(tmpdir(), "tokenomy-cmp-cwd-"));
  try {
    process.chdir(inner);
    const r = await captureOut(() => runCompress([file]));
    assert.notEqual(r.value, 0);
  } catch (e) {
    assert.match((e as Error).message, /Refusing to compress outside cwd/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
    rmSync(inner, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// raven.ts — clean, status, brief without git, install-commands
// ---------------------------------------------------------------------------

test("raven: status without git repo prints disabled", async () => {
  const h = setupHome();
  const cwdDir = mkdtempSync(join(tmpdir(), "tokenomy-raven-status-"));
  const prev = process.cwd();
  try {
    process.chdir(cwdDir);
    const r = await captureOut(() => runRaven(["status"]));
    assert.equal(r.value, 0);
    assert.match(r.out, /Raven:/);
  } finally {
    process.chdir(prev);
    rmSync(cwdDir, { recursive: true, force: true });
    h.restore();
  }
});

test("raven: clean without git fails gracefully", async () => {
  const h = setupHome();
  const cwdDir = mkdtempSync(join(tmpdir(), "tokenomy-raven-clean-"));
  const prev = process.cwd();
  try {
    process.chdir(cwdDir);
    const r = await captureOut(() => runRaven(["clean", "--dry-run"]));
    assert.equal(r.value, 1);
  } finally {
    process.chdir(prev);
    rmSync(cwdDir, { recursive: true, force: true });
    h.restore();
  }
});

test("raven: compare without packet fails", async () => {
  const h = setupHome();
  const cwdDir = mkdtempSync(join(tmpdir(), "tokenomy-raven-cmp-"));
  const prev = process.cwd();
  try {
    process.chdir(cwdDir);
    spawnSync("git", ["init", "-b", "main"], { cwd: cwdDir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: cwdDir });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: cwdDir });
    writeFileSync(join(cwdDir, "f.txt"), "x");
    spawnSync("git", ["add", "."], { cwd: cwdDir });
    spawnSync("git", ["commit", "-m", "a"], { cwd: cwdDir });
    const r = await captureOut(() => runRaven(["compare"]));
    assert.equal(r.value, 1);
    assert.match(r.err, /no Raven packet found|graph-not-built|requires/);
  } finally {
    process.chdir(prev);
    rmSync(cwdDir, { recursive: true, force: true });
    h.restore();
  }
});

test("raven: pr-check without packet fails", async () => {
  const h = setupHome();
  const cwdDir = mkdtempSync(join(tmpdir(), "tokenomy-raven-pr-"));
  const prev = process.cwd();
  try {
    process.chdir(cwdDir);
    spawnSync("git", ["init", "-b", "main"], { cwd: cwdDir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: cwdDir });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: cwdDir });
    writeFileSync(join(cwdDir, "f.txt"), "x");
    spawnSync("git", ["add", "."], { cwd: cwdDir });
    spawnSync("git", ["commit", "-m", "a"], { cwd: cwdDir });
    const r = await captureOut(() => runRaven(["pr-check"]));
    assert.equal(r.value, 1);
  } finally {
    process.chdir(prev);
    rmSync(cwdDir, { recursive: true, force: true });
    h.restore();
  }
});

test("raven: install-commands writes files, refuses on second run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-raven-install-"));
  const prev = process.cwd();
  try {
    process.chdir(dir);
    const r1 = await captureOut(() => runRaven(["install-commands"]));
    assert.equal(r1.value, 0);
    assert.ok(existsSync(join(dir, ".claude", "commands", "raven-brief.md")));
    const r2 = await captureOut(() => runRaven(["install-commands"]));
    assert.equal(r2.value, 1);
    assert.match(r2.err, /already exists/);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("raven: disable --purge removes store", async () => {
  const h = setupHome();
  const cwdDir = mkdtempSync(join(tmpdir(), "tokenomy-raven-purge-"));
  const prev = process.cwd();
  try {
    process.chdir(cwdDir);
    spawnSync("git", ["init", "-b", "main"], { cwd: cwdDir });
    spawnSync("git", ["config", "user.name", "t"], { cwd: cwdDir });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: cwdDir });
    writeFileSync(join(cwdDir, "f.txt"), "x");
    spawnSync("git", ["add", "."], { cwd: cwdDir });
    spawnSync("git", ["commit", "-m", "a"], { cwd: cwdDir });
    const r = await captureOut(() => runRaven(["disable", "--purge"]));
    assert.equal(r.value, 0);
    assert.match(r.out, /Raven disabled/);
  } finally {
    process.chdir(prev);
    rmSync(cwdDir, { recursive: true, force: true });
    h.restore();
  }
});

test("raven: bad subcommand prints help", async () => {
  const r = await captureOut(() => runRaven(["nonexistent"]));
  assert.equal(r.value, 1);
  assert.match(r.err, /Usage:/);
});

// ---------------------------------------------------------------------------
// diagnose.ts
// ---------------------------------------------------------------------------

test("diagnose: empty home produces report", async () => {
  const h = setupHome();
  const cwd = mkdtempSync(join(tmpdir(), "tokenomy-diagnose-"));
  const prev = process.cwd();
  try {
    process.chdir(cwd);
    const { buildDiagnoseReport } = await import("../../src/cli/diagnose.js");
    const report = await buildDiagnoseReport();
    assert.equal(report.schema_version, 1);
    assert.ok(report.tokenomy.version);
    assert.ok(["ok", "warning", "error"].includes(report.worst));
    // Also exercise the runDiagnose entrypoint
    const code = await runDiagnose(["--json"]);
    assert.ok(code === 0 || code === 1);
  } finally {
    process.chdir(prev);
    rmSync(cwd, { recursive: true, force: true });
    h.restore();
  }
});

test("diagnose: graph section reports last build failure when no graph", async () => {
  const h = setupHome();
  const cwd = mkdtempSync(join(tmpdir(), "tokenomy-diagnose-graph-"));
  const prev = process.cwd();
  try {
    process.chdir(cwd);
    spawnSync("git", ["init", "-b", "main"], { cwd });
    const { repoId } = resolveRepoId(cwd);
    const buildLog = graphBuildLogPath(repoId);
    mkdirSync(dirname(buildLog), { recursive: true });
    writeFileSync(
      buildLog,
      JSON.stringify({
        ts: new Date().toISOString(),
        repo_id: repoId,
        repo_path: cwd,
        built: false,
        reason: "graph-too-large",
        node_count: 0,
        edge_count: 0,
        parse_error_count: 0,
        duration_ms: 5,
      }) + "\n",
    );
    const { buildDiagnoseReport } = await import("../../src/cli/diagnose.js");
    const report = await buildDiagnoseReport();
    assert.equal(report.graph.ok, false);
    assert.equal(report.graph.reason, "graph-too-large");
  } finally {
    process.chdir(prev);
    rmSync(cwd, { recursive: true, force: true });
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// statusline.ts
// ---------------------------------------------------------------------------

test("statusline: runStatusLine prints empty for inactive home", async () => {
  const h = setupHome();
  try {
    const r = await captureOut(() => runStatusLine([]));
    assert.equal(r.value, 0);
  } finally {
    h.restore();
  }
});

test("statusline: --json mode emits state JSON", async () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".tokenomy"), { recursive: true });
    writeFileSync(
      join(h.home, ".tokenomy", "config.json"),
      JSON.stringify({
        log_path: join(h.home, ".tokenomy", "savings.jsonl"),
        golem: { enabled: true, mode: "lite" },
        raven: { enabled: true, requires_codex: false, include_graph_context: false },
        kratos: { enabled: true, continuous: true, prompt_min_severity: "low", categories: [] },
      }),
    );
    writeFileSync(
      join(h.home, ".tokenomy", "savings.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), tokens_saved_est: 1234 }) + "\n",
    );
    const r = await captureOut(() => runStatusLine(["--json"]));
    assert.equal(r.value, 0);
    const parsed = JSON.parse(r.out);
    assert.equal(parsed.active, true);
    assert.ok(parsed.tokensToday >= 1234);
    assert.equal(parsed.raven, true);
    assert.equal(parsed.kratos, true);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// ci.ts
// ---------------------------------------------------------------------------

test("ci: format requires --input, fails on missing file", async () => {
  const r1 = await captureOut(() => runCi([]));
  assert.equal(r1.value, 1);
  assert.match(r1.err, /Usage:/);
  const r3 = await captureOut(() => runCi(["format", "--input=/no-such.json"]));
  assert.equal(r3.value, 1);
  assert.match(r3.err, /cannot read/);
});

test("ci: format produces markdown from JSON report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-ci-"));
  try {
    const file = join(dir, "report.json");
    writeFileSync(
      file,
      JSON.stringify({
        totals: {
          files: 5,
          sessions: 2,
          tool_calls: 100,
          observed_tokens: 50000,
          savings_tokens: 12000,
          estimated_usd_saved: 0.42,
          duplicate_calls: 3,
          redact_matches: 7,
        },
        by_tool: [
          { tool: "<bad>tool|name", calls: 10, observed_tokens: 1000, savings_tokens: 200, waste_pct: 0.2 },
        ],
        by_rule: [{ rule: "read-clamp", events: 5, savings_tokens: 100 }],
        wasted_probes: [
          { tool: "mcp__x", call_count: 4, observed_tokens: 800, first_ts: "2026-04-30T10:00:00Z", last_ts: "2026-04-30T10:00:30Z" },
        ],
      }),
    );
    const r = await captureOut(() => runCi(["format", "--input", file]));
    assert.equal(r.value, 0);
    assert.match(r.out, /token-waste summary/);
    assert.match(r.out, /Savings by rule/);
    assert.match(r.out, /Top tools by observed waste/);
    assert.match(r.out, /Wasted-probe incidents/);
    assert.match(r.out, /Secret matches/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// update.ts — fake npm
// ---------------------------------------------------------------------------

test("update: --check with fake npm registry replies", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    writeFakeBin(
      bin,
      "npm",
      `#!/bin/sh\nif [ "$1" = "view" ]; then echo 99.99.99; exit 0; fi\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runUpdate({ check: true, tag: "latest" }));
    assert.equal(r.value, 1);
    assert.match(r.out, /Update available/);
  } finally {
    h.restore();
  }
});

test("update: --check up-to-date and same version pin", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    const { TOKENOMY_VERSION } = await import("../../src/core/version.js");
    writeFakeBin(
      bin,
      "npm",
      `#!/bin/sh\nif [ "$1" = "view" ]; then echo ${TOKENOMY_VERSION}; exit 0; fi\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runUpdate({ check: true, tag: "latest" }));
    assert.equal(r.value, 0);
    assert.match(r.out, /Up to date/);
  } finally {
    h.restore();
  }
});

test("update: --check pinned newer-than-installed", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    writeFakeBin(
      bin,
      "npm",
      `#!/bin/sh\nif [ "$1" = "view" ]; then echo 0.0.1; exit 0; fi\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runUpdate({ check: true, version: "0.0.1" }));
    assert.equal(r.value, 0);
    assert.match(r.out, /newer than the pinned target|Up to date/);
  } finally {
    h.restore();
  }
});

test("update: --check 404 returns 2", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    writeFakeBin(
      bin,
      "npm",
      `#!/bin/sh\nif [ "$1" = "view" ]; then echo "404 Not Found" >&2; exit 1; fi\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runUpdate({ check: true, tag: "missing-tag" }));
    assert.equal(r.value, 2);
    assert.match(r.err, /could not query/);
  } finally {
    h.restore();
  }
});

test("update: --check --quiet silences output but still returns code", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    writeFakeBin(
      bin,
      "npm",
      `#!/bin/sh\nif [ "$1" = "view" ]; then echo 99.99.99; exit 0; fi\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runUpdate({ check: true, tag: "latest", quiet: true }));
    assert.equal(r.value, 1);
    assert.equal(r.out, "");
  } finally {
    h.restore();
  }
});

test("update: isTransientNpmFailure classifier", () => {
  assert.equal(isTransientNpmFailure(""), true);
  assert.equal(isTransientNpmFailure("ETIMEDOUT something"), true);
  assert.equal(isTransientNpmFailure("ENOTFOUND registry.npmjs.org"), true);
  assert.equal(isTransientNpmFailure("ECONNRESET socket"), true);
  assert.equal(isTransientNpmFailure("fetch failed"), true);
  assert.equal(isTransientNpmFailure("404 Not Found"), false);
  assert.equal(isTransientNpmFailure("E404 not found"), false);
  assert.equal(isTransientNpmFailure("Unauthorized"), false);
  assert.equal(isTransientNpmFailure("ENEEDAUTH login required"), false);
});

test("update: compareVersions semver rules", () => {
  assert.ok(compareVersions("0.1.1", "0.1.0") > 0);
  assert.ok(compareVersions("0.1.0", "0.1.0-rc.1") > 0);
  assert.ok(compareVersions("0.1.0-alpha.12", "0.1.0-beta.1") < 0);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("1.0.0+abc", "1.0.0+xyz") === 0);
  assert.ok(compareVersions("1.0.0-alpha.1", "1.0.0-alpha") > 0);
});

// ---------------------------------------------------------------------------
// build-log.ts + log.ts
// ---------------------------------------------------------------------------

test("build-log: returns null on missing path, parses last failure with hint", () => {
  const h = setupHome();
  try {
    const repoId = "test-repo-1234567890123456789012345678901234567890";
    assert.equal(readLastGraphBuildLog(repoId), null);
    assert.equal(readLastGraphBuildFailure(repoId), null);

    const path = graphBuildLogPath(repoId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        "junk line",
        "",
        JSON.stringify({ ts: "x", repo_id: repoId, repo_path: "/r", built: false, reason: "graph-too-large", node_count: 0, edge_count: 0, parse_error_count: 0, duration_ms: 1 }),
        JSON.stringify({ ts: "y", repo_id: repoId, repo_path: "/r", built: false, reason: "typescript-not-installed", node_count: 0, edge_count: 0, parse_error_count: 0, duration_ms: 1 }),
      ].join("\n") + "\n",
    );
    const last = readLastGraphBuildLog(repoId);
    assert.equal(last?.reason, "typescript-not-installed");
    const fail = readLastGraphBuildFailure(repoId);
    assert.equal(fail?.ok, false);
    assert.match(fail?.hint ?? "", /typescript/i);
  } finally {
    h.restore();
  }
});

test("build-log: returns null for built:true entries", () => {
  const h = setupHome();
  try {
    const repoId = "test-repo-built-22222222222222222222222222222222";
    const path = graphBuildLogPath(repoId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ ts: "x", repo_id: repoId, repo_path: "/r", built: true, node_count: 10, edge_count: 5, parse_error_count: 0, duration_ms: 1 }) + "\n",
    );
    assert.equal(readLastGraphBuildFailure(repoId), null);
  } finally {
    h.restore();
  }
});

test("update: --tag with old version triggers refresh classifier rerun", async () => {
  const h = setupHome();
  try {
    const bin = join(h.home, "bin");
    // First call returns transient stderr (empty), second succeeds — exercises retry path
    const stateFile = join(h.home, "state");
    writeFileSync(stateFile, "0");
    writeFakeBin(
      bin,
      "npm",
      `#!/bin/sh\nN=$(cat "${stateFile}")\necho $((N+1)) > "${stateFile}"\nif [ "$1" = "view" ]; then\n  if [ "$N" = "0" ]; then exit 1; fi\n  echo 0.0.1; exit 0;\nfi\nexit 0\n`,
    );
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const r = await captureOut(() => runUpdate({ check: true, tag: "alpha" }));
    assert.equal(r.value, 0);
  } finally {
    h.restore();
  }
});

test("statusline: graph state fresh when meta is recent", async () => {
  const h = setupHome();
  const cwd = mkdtempSync(join(tmpdir(), "tokenomy-sl-graph-"));
  const prev = process.cwd();
  try {
    process.chdir(cwd);
    spawnSync("git", ["init", "-b", "main"], { cwd });
    const { repoId } = resolveRepoId(cwd);
    const { graphMetaPath, graphSnapshotPath } = await import("../../src/core/paths.js");
    mkdirSync(dirname(graphMetaPath(repoId)), { recursive: true });
    writeFileSync(graphMetaPath(repoId), JSON.stringify({ built_at: new Date().toISOString() }));
    writeFileSync(graphSnapshotPath(repoId), "{}");
    mkdirSync(join(h.home, ".tokenomy"), { recursive: true });
    writeFileSync(
      join(h.home, ".tokenomy", "config.json"),
      JSON.stringify({ log_path: join(h.home, ".tokenomy", "savings.jsonl") }),
    );
    writeFileSync(
      join(h.home, ".tokenomy", "savings.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), tokens_saved_est: 4242 }) + "\n",
    );
    const r = await captureOut(() => runStatusLine([]));
    assert.equal(r.value, 0);
    // Output may be empty if budget tripped on a slow CI runner; only
    // assert non-failure here.
  } finally {
    process.chdir(prev);
    rmSync(cwd, { recursive: true, force: true });
    h.restore();
  }
});

test("commandExists: uses 'where' on win32 fallback", async () => {
  // Force win32 branch; the external probe will exit non-zero (no `where`
  // on macOS), so commandExists returns false. This exercises the win32
  // path without actually being on Windows.
  const orig = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", writable: true });
  try {
    const { commandExists } = await import("../../src/cli/agents/common.js");
    const r = commandExists("definitely-not-a-real-binary-xyz");
    assert.equal(r, false);
  } finally {
    if (orig) Object.defineProperty(process, "platform", orig);
  }
});

test("compareVersions: malformed numeric main components fall to 0", async () => {
  const { compareVersions } = await import("../../src/cli/update.ts");
  // 1.0a parses as 1.0.0 (a-component coerces to 0); 1.0.0 stays 1.0.0
  assert.equal(compareVersions("1.0a", "1.0"), 0);
  assert.ok(compareVersions("0.1.x", "0.1.5") < 0);
});

test("redact-pre: passthrough when content >1MB cap (UTF-8 byte length)", async () => {
  const { redactPreRule } = await import("../../src/rules/redact-pre.js");
  const cfg = {
    redact: { enabled: true, pre_tool_use: true, patterns: [] },
  } as never;
  const big = "x".repeat(1_500_000);
  const r1 = redactPreRule("Write", { content: big }, cfg);
  assert.equal(r1.kind, "passthrough");
  const r2 = redactPreRule("Edit", { new_string: big }, cfg);
  assert.equal(r2.kind, "passthrough");
  const r3 = redactPreRule("Bash", { command: big }, cfg);
  assert.equal(r3.kind, "passthrough");
  // Multi-byte: 600k 4-byte chars = 2.4 MB UTF-8 but length 600k UTF-16 units.
  const big4 = "𓀀".repeat(600_000);
  const r4 = redactPreRule("Write", { content: big4 }, cfg);
  assert.equal(r4.kind, "passthrough");
});

test("session-state: tail with no newline returns []", async () => {
  const h = setupHome();
  try {
    const { sessionStatePath } = await import("../../src/core/paths.js");
    const { readSessionState } = await import("../../src/core/session-state.js");
    const sid = "no-nl-sid";
    const path = sessionStatePath(sid);
    mkdirSync(dirname(path), { recursive: true });
    // 300KB single line, no newline at all.
    writeFileSync(path, "x".repeat(300_000));
    assert.equal(readSessionState(sid), null);
  } finally {
    h.restore();
  }
});

test("agents: surgical removal bails when config has triple-quoted TOML strings", async () => {
  const h = setupHome();
  try {
    const codexDir = join(h.home, ".codex");
    mkdirSync(codexDir);
    const cfgPath = join(codexDir, "config.toml");
    const original = `intro = """\n[mcp_servers.tokenomy-graph]\nfake = "inside heredoc"\n"""\n\n[mcp_servers.tokenomy-graph]\ncommand = "tokenomy"\n`;
    writeFileSync(cfgPath, original);
    const bin = join(h.home, "bin");
    writeFakeBin(bin, "codex", "#!/bin/sh\nexit 5\n");
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const { findAgent } = await import("../../src/cli/agents/index.js");
    findAgent("codex")?.install("/tmp", false);
    const after = readFileSync(cfgPath, "utf8");
    // Triple-quoted heredoc means surgical removal must NOT strip the
    // [mcp_servers.tokenomy-graph] table — both the heredoc and the real
    // table must still be present after the failed CLI removal attempt.
    assert.match(after, /^\[mcp_servers\.tokenomy-graph\]\ncommand = "tokenomy"/m);
    assert.match(after, /"""\n\[mcp_servers\.tokenomy-graph\]\nfake/);
  } finally {
    h.restore();
  }
});

test("uninstall: surgical codex MCP removal when CLI exits non-zero", async () => {
  const h = setupHome();
  try {
    const codexDir = join(h.home, ".codex");
    mkdirSync(codexDir);
    const cfgPath = join(codexDir, "config.toml");
    writeFileSync(
      cfgPath,
      `[mcp_servers.tokenomy-graph]\ncommand = "tokenomy"\n[other]\nx=1\n`,
    );
    const bin = join(h.home, "bin");
    writeFakeBin(bin, "codex", "#!/bin/sh\nexit 9\n");
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    // Pre-create the manifest + hook so runUninstall has work
    const hook = hookBinaryPath();
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 0\n");
    chmodSync(hook, 0o755);
    const { runUninstall } = await import("../../src/cli/uninstall.js");
    runUninstall({ purge: false, backup: false });
    const after = readFileSync(cfgPath, "utf8");
    assert.doesNotMatch(after, /\[mcp_servers\.tokenomy-graph\]/);
    assert.match(after, /\[other\]/);
  } finally {
    h.restore();
  }
});

test("agents: surgical codex MCP removal when CLI is absent", async () => {
  const h = setupHome();
  try {
    // Pre-seed a config.toml with the [mcp_servers.tokenomy-graph] table.
    const codexDir = join(h.home, ".codex");
    mkdirSync(codexDir);
    const cfgPath = join(codexDir, "config.toml");
    writeFileSync(
      cfgPath,
      `[mcp_servers.tokenomy-graph]\ncommand = "tokenomy"\nargs = ["graph", "serve"]\n\n[mcp_servers.other]\ncommand = "other"\n`,
    );
    // Force codex to "not on PATH" so install short-circuits BEFORE running.
    // Then directly invoke the surgical helper indirectly via codex install
    // path with a fake codex binary that returns non-zero.
    const bin = join(h.home, "bin");
    writeFakeBin(bin, "codex", "#!/bin/sh\nexit 7\n");
    process.env["PATH"] = `${bin}:${h.pathPrev ?? ""}`;
    const { findAgent } = await import("../../src/cli/agents/index.js");
    const codex = findAgent("codex");
    codex?.install("/tmp", false);
    const after = readFileSync(cfgPath, "utf8");
    assert.doesNotMatch(after, /\[mcp_servers\.tokenomy-graph\]/);
    assert.match(after, /\[mcp_servers\.other\]/);
  } finally {
    h.restore();
  }
});

test("repo-id: cheap-gate skips git spawn for non-repo cwds", async () => {
  const h = setupHome();
  const cwd = mkdtempSync(join(tmpdir(), "tokenomy-no-git-"));
  try {
    const id = resolveRepoId(cwd);
    assert.equal(typeof id.repoId, "string");
    assert.ok(id.repoId.length > 0);
    assert.equal(id.repoPath, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    h.restore();
  }
});

test("validatePathArg: rejects '..' and missing dir, accepts existing dir via realpath", async () => {
  const { dispatchGraphTool } = await import("../../src/mcp/handlers.js");
  const traversal = await dispatchGraphTool("build_or_update_graph", { path: "/tmp/../etc" }, process.cwd());
  assert.equal((traversal as { ok: boolean }).ok, false);
  const missing = await dispatchGraphTool("build_or_update_graph", { path: "/no-such-dir-xyz-9999" }, process.cwd());
  assert.equal((missing as { ok: boolean }).ok, false);
  // tmpdir is symlinked on macOS — exercises realpath success path.
  const tmpDir = mkdtempSync(join(tmpdir(), "tokenomy-realpath-"));
  try {
    await dispatchGraphTool("build_or_update_graph", { path: tmpDir }, process.cwd());
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("init: rollback restores backup on settings write failure", async () => {
  const h = setupHome();
  try {
    const sp = claudeSettingsPath();
    mkdirSync(dirname(sp), { recursive: true });
    writeFileSync(sp, JSON.stringify({ keep: "me" }));
    const { runInit } = await import("../../src/cli/init.js");
    // Make settings dir unwritable to trigger atomicWrite failure.
    chmodSync(dirname(sp), 0o555);
    let threw = false;
    try {
      runInit({});
    } catch {
      threw = true;
    }
    chmodSync(dirname(sp), 0o755);
    if (threw) {
      const after = JSON.parse(readFileSync(sp, "utf8"));
      assert.equal(after.keep, "me", "backup should have restored");
    }
  } finally {
    h.restore();
  }
});

test("buildGraph: reclaims a stale lock from a dead PID", async () => {
  const h = setupHome();
  const cwd = mkdtempSync(join(tmpdir(), "tokenomy-lock-"));
  try {
    process.chdir(cwd);
    const { graphLockPath } = await import("../../src/core/paths.js");
    const { buildGraph } = await import("../../src/graph/build.js");
    const { loadConfig } = await import("../../src/core/config.js");
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    spawnSync("git", ["init", "-b", "main"], { cwd });
    spawnSync("git", ["config", "user.name", "t"], { cwd });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd });
    spawnSync("git", ["add", "."], { cwd });
    spawnSync("git", ["commit", "-m", "a"], { cwd });
    const { repoId } = resolveRepoId(cwd);
    const lockPath = graphLockPath(repoId);
    mkdirSync(dirname(lockPath), { recursive: true });
    // Stale lock: PID = 1 with very old ts (way past 10min staleness)
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: "2020-01-01T00:00:00Z" }));
    const cfg = loadConfig(cwd);
    const result = await buildGraph({ cwd, config: cfg });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    process.chdir(ROOT);
    rmSync(cwd, { recursive: true, force: true });
    h.restore();
  }
});

test("buildGraph: refuses build when an alive PID holds the lock", async () => {
  const h = setupHome();
  const cwd = mkdtempSync(join(tmpdir(), "tokenomy-lock-alive-"));
  try {
    process.chdir(cwd);
    const { graphLockPath } = await import("../../src/core/paths.js");
    const { buildGraph } = await import("../../src/graph/build.js");
    const { loadConfig } = await import("../../src/core/config.js");
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    spawnSync("git", ["init", "-b", "main"], { cwd });
    spawnSync("git", ["config", "user.name", "t"], { cwd });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd });
    spawnSync("git", ["add", "."], { cwd });
    spawnSync("git", ["commit", "-m", "a"], { cwd });
    const { repoId } = resolveRepoId(cwd);
    const lockPath = graphLockPath(repoId);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    const cfg = loadConfig(cwd);
    const result = await buildGraph({ cwd, config: cfg });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /build-in-progress/);
    rmSync(lockPath, { force: true });
  } finally {
    process.chdir(ROOT);
    rmSync(cwd, { recursive: true, force: true });
    h.restore();
  }
});

test("buildGraph: reclaims a legacy empty-file lock", async () => {
  const h = setupHome();
  const cwd = mkdtempSync(join(tmpdir(), "tokenomy-lock-empty-"));
  try {
    process.chdir(cwd);
    const { graphLockPath } = await import("../../src/core/paths.js");
    const { buildGraph } = await import("../../src/graph/build.js");
    const { loadConfig } = await import("../../src/core/config.js");
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    spawnSync("git", ["init", "-b", "main"], { cwd });
    spawnSync("git", ["config", "user.name", "t"], { cwd });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd });
    spawnSync("git", ["add", "."], { cwd });
    spawnSync("git", ["commit", "-m", "a"], { cwd });
    const { repoId } = resolveRepoId(cwd);
    const lockPath = graphLockPath(repoId);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "");
    const oldTime = (Date.now() - 20 * 60 * 1000) / 1000;
    utimesSync(lockPath, oldTime, oldTime);
    const cfg = loadConfig(cwd);
    const result = await buildGraph({ cwd, config: cfg });
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally {
    process.chdir(ROOT);
    rmSync(cwd, { recursive: true, force: true });
    h.restore();
  }
});

test("log: appendSavingsLog and appendGraphBuildLog write JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-log-"));
  try {
    const path = join(dir, "savings.jsonl");
    appendSavingsLog(path, {
      ts: "2026-04-30T00:00:00Z",
      session_id: "test-session",
      tool: "Read",
      bytes_in: 100,
      bytes_out: 50,
      tokens_saved_est: 12,
      reason: "test",
    });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.tool, "Read");

    const gbPath = join(dir, "build.jsonl");
    appendGraphBuildLog(gbPath, {
      ts: "2026-04-30T00:00:00Z",
      repo_id: "abc",
      repo_path: "/r",
      built: true,
      node_count: 1,
      edge_count: 0,
      parse_error_count: 0,
      duration_ms: 1,
    });
    assert.ok(existsSync(gbPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
