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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { enumerateTranscripts, scan } from "../../src/analyze/scan.js";
import { computeGolemTune, writeGolemTune } from "../../src/analyze/tune.js";
import { buildGraph } from "../../src/graph/build.js";
import { loadConfig } from "../../src/core/config.js";
import {
  analyzeCachePath,
  golemTunePath,
  hookBinaryPath,
  updateCachePath,
} from "../../src/core/paths.js";
import { TOKENOMY_VERSION } from "../../src/core/version.js";
import { runAnalyze } from "../../src/cli/analyze.js";
import { runBenchCli } from "../../src/cli/bench.js";
import { runDiff } from "../../src/cli/diff.js";
import { runDoctor, runDoctorFix } from "../../src/cli/doctor.js";
import { runGraphQuery } from "../../src/cli/graph-query.js";
import { runLearn } from "../../src/cli/learn.js";
import { runRaven } from "../../src/cli/raven.js";
import { runUpdate } from "../../src/cli/update.js";
import {
  _queryCacheSize,
  _resetQueryCacheForTests,
  dispatchGraphTool,
} from "../../src/mcp/handlers.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const withTmpHome = async <T>(fn: (home: string) => T | Promise<T>): Promise<T> => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-coverage-home-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    return await fn(home);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
};

const withCwd = async <T>(cwd: string, fn: () => T | Promise<T>): Promise<T> => {
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
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
    if (typeof enc === "function") enc();
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
    err += append(chunk);
    if (typeof enc === "function") enc();
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), out, err };
  } finally {
    process.stdout.write = ow;
    process.stderr.write = ew;
  }
};

const writeConfig = (
  home: string,
  extra: Record<string, unknown> = {},
): void => {
  const path = join(home, ".tokenomy", "config.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        log_path: join(home, ".tokenomy", "savings.jsonl"),
        raven: {
          enabled: false,
          requires_codex: false,
          include_graph_context: true,
        },
        ...extra,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
};

const jsonLine = (value: unknown): string => JSON.stringify(value);

const claudeToolUse = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  project: string,
  timestamp: string,
): string =>
  jsonLine({
    type: "assistant",
    sessionId: "session-a",
    cwd: project,
    timestamp,
    message: {
      content: [{ type: "tool_use", id, name, input }],
    },
  });

const claudeToolResult = (
  id: string,
  content: string,
  project: string,
  timestamp: string,
): string =>
  jsonLine({
    type: "user",
    sessionId: "session-a",
    cwd: project,
    timestamp,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: [{ type: "text", text: content }],
          is_error: false,
        },
      ],
    },
  });

const claudeAssistantText = (text: string, project: string, sessionId: string): string =>
  jsonLine({
    type: "assistant",
    sessionId,
    cwd: project,
    timestamp: "2026-04-18T10:05:00Z",
    message: { content: [{ type: "text", text }] },
  });

const codexAssistantText = (text: string, project: string): string =>
  [
    jsonLine({
      type: "session_meta",
      timestamp: "2026-04-18T10:06:00Z",
      payload: { id: "codex-session", cwd: project },
    }),
    jsonLine({
      type: "response_item",
      timestamp: "2026-04-18T10:06:01Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    }),
  ].join("\n");

const synthesizeClaudeTranscript = (projectsDir: string, project: string): string => {
  const sessionDir = join(projectsDir, "-coverage-project");
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, "session-a.jsonl");
  const huge = "needle " + "x".repeat(50_000);
  const lines = [
    claudeToolUse("t1", "mcp__fake__big", { id: 1, query: "needle" }, project, "2026-04-18T10:00:00Z"),
    claudeToolResult("t1", huge, project, "2026-04-18T10:00:01Z"),
    claudeToolUse("t2", "mcp__fake__big", { id: 1, query: "needle" }, project, "2026-04-18T10:01:00Z"),
    claudeToolResult("t2", huge, project, "2026-04-18T10:01:02Z"),
    claudeToolUse("t3", "Read", { file_path: "/tmp/large.ts" }, project, "2026-04-18T10:02:00Z"),
    claudeToolResult("t3", Array.from({ length: 1200 }, (_, i) => `line ${i}`).join("\n"), project, "2026-04-18T10:02:01Z"),
    claudeAssistantText("large claude answer ".repeat(450), project, "session-a"),
  ];
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
};

const synthesizeCodexTranscript = (home: string, project: string): string => {
  const dir = join(home, ".codex", "sessions", "2026", "04", "18");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "rollout-coverage.jsonl");
  writeFileSync(file, codexAssistantText("large codex answer ".repeat(300), project) + "\n", "utf8");
  return file;
};

const initGitRepo = (repo: string): void => {
  const run = (args: string[]): void => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  };
  run(["init", "-b", "main"]);
  run(["config", "user.name", "Tokenomy Test"]);
  run(["config", "user.email", "tokenomy@example.test"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "base.ts"), "export const base = 1;\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
  run(["checkout", "-b", "feature/coverage"]);
  writeFileSync(join(repo, "src", "feature.ts"), "export const feature = base + 1;\n", "utf8");
  run(["add", "."]);
  run(["commit", "-m", "add feature"]);
  writeFileSync(join(repo, "src", "feature.ts"), "export const feature = base + 2;\n", "utf8");
  writeFileSync(join(repo, "src", "untracked.ts"), "export const untracked = true;\n", "utf8");
};

const makeGitRepo = (): { repo: string; cleanup: () => void } => {
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-coverage-repo-"));
  initGitRepo(repo);
  return {
    repo,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
};

const makeGraphRepo = (): { repo: string; cleanup: () => void } => {
  const parent = mkdtempSync(join(tmpdir(), "tokenomy-coverage-graph-"));
  const repo = join(parent, "repo");
  cpSync(join(ROOT, "tests", "fixtures", "graph-fixture-repo"), repo, { recursive: true });
  return {
    repo,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
};

const installDoctorFiles = (
  home: string,
  logDir: string,
): void => {
  const hook = hookBinaryPath();
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, "#!/bin/sh\ncat >/dev/null\nexit 0\n", "utf8");
  chmodSync(hook, 0o755);

  const command = `"${hook}"`;
  const settingsPath = join(home, ".claude", "settings.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [{ matcher: "mcp__.*", hooks: [{ type: "command", command, timeout: 10 }] }],
          PreToolUse: [{ matcher: "Read|Bash|Write|Edit", hooks: [{ type: "command", command, timeout: 10 }] }],
          UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }],
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command, timeout: 10 }] }],
        },
        statusLine: { type: "command", command: "tokenomy status-line" },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify(
      {
        mcpServers: {
          "tokenomy-graph": { type: "stdio", command: "tokenomy", args: ["graph", "serve"] },
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  writeFileSync(
    join(home, ".tokenomy", "installed.json"),
    JSON.stringify(
      {
        version: 1,
        entries: [
          {
            command_path: hook,
            settings_path: settingsPath,
            matcher: "mcp__.*",
            installed_at: "2026-04-18T10:00:00Z",
          },
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(home, ".tokenomy", "debug.jsonl"),
    [
      jsonLine({ elapsed_ms: 4 }),
      jsonLine({ elapsed_ms: 8 }),
      jsonLine({ elapsed_ms: 12 }),
    ].join("\n") + "\n",
    "utf8",
  );
};

test("doctor source checks cover healthy and fixable homes", async () => {
  await withTmpHome(async (home) => {
    const logDir = join(home, "logs");
    writeConfig(home, {
      log_path: join(logDir, "savings.jsonl"),
      perf: { p95_budget_ms: 50, sample_size: 3 },
    });
    installDoctorFiles(home, logDir);

    const checks = await runDoctor();
    const byName = new Map(checks.map((check) => [check.name, check]));
    assert.equal(byName.get("~/.claude/settings.json parses")?.ok, true);
    assert.equal(byName.get("Hook entries present (PostToolUse + PreToolUse + UserPromptSubmit + SessionStart)")?.ok, true);
    assert.equal(byName.get("Hook binary exists + executable")?.ok, true);
    assert.equal(byName.get("Smoke spawn hook (empty mcp call)")?.ok, true);
    assert.equal(byName.get("Statusline registered")?.ok, true);
    assert.equal(byName.get("Hook perf budget")?.ok, true);
  });

  await withTmpHome(async (home) => {
    const missingLogDir = join(home, "missing", "logs");
    writeConfig(home, {
      log_path: join(missingLogDir, "savings.jsonl"),
      perf: { p95_budget_ms: 50, sample_size: 3 },
    });
    installDoctorFiles(home, join(home, "throwaway-logs"));

    const before = await runDoctor();
    assert.equal(before.find((check) => check.name === "Log directory writable")?.ok, false);
    const fixed = await runDoctorFix();
    assert.ok(fixed.some((check) => check.name === "Log directory writable" && check.ok));
    assert.equal(existsSync(missingLogDir), true);
  });
});

test("analyze, scan, tune, and diff run against synthetic source transcripts", async () => {
  await withTmpHome(async (home) => {
    writeConfig(home, {
      report: { price_per_million: 6 },
      golem: { enabled: true, mode: "auto" },
    });
    const project = join(home, "project");
    mkdirSync(project, { recursive: true });
    const projects = join(home, ".claude", "projects");
    mkdirSync(projects, { recursive: true });
    const claudeFile = synthesizeClaudeTranscript(projects, project);
    const codexFile = synthesizeCodexTranscript(home, project);

    const enumerated = enumerateTranscripts([projects, join(home, ".codex", "sessions"), join(home, "missing")]);
    assert.ok(enumerated.includes(claudeFile));
    assert.ok(enumerated.includes(codexFile));

    const calls: string[] = [];
    const progress: Array<{ file_index: number; file_total: number; bytes_read: number; elapsed_ms: number }> = [];
    const stats = await scan(
      {
        roots: [projects],
        since: new Date("2026-04-01T00:00:00Z"),
        projectFilter: "project",
        sessionFilter: "session-a",
        progressEveryFiles: 1,
        onProgress: (event) => progress.push(event),
      },
      (call) => calls.push(call.tool_name),
    );
    assert.equal(stats.files, 1);
    assert.ok(stats.lines >= 6);
    assert.ok(progress.length >= 1);
    assert.deepEqual(calls, ["mcp__fake__big", "mcp__fake__big", "Read"]);

    const analyze = await captureOut(() =>
      runAnalyze({
        path: projects,
        since: "all",
        tokenizer: "heuristic",
        json: true,
        verbose: true,
        tune: true,
        cache: true,
        top: 3,
      }),
    );
    assert.equal(analyze.value, 0);
    const report = JSON.parse(analyze.out) as {
      totals: { tool_calls: number; duplicate_calls: number; observed_tokens: number };
      by_tool: Array<{ tool: string }>;
    };
    assert.equal(report.totals.tool_calls, 3);
    assert.equal(report.totals.duplicate_calls, 1);
    assert.ok(report.totals.observed_tokens > 0);
    assert.ok(report.by_tool.some((row) => row.tool === "mcp__fake__big"));
    assert.equal(existsSync(analyzeCachePath()), true);
    assert.equal(existsSync(golemTunePath()), true);
    assert.match(analyze.err, /Golem tune written/);

    const invalidAnalyze = await captureOut(() => runAnalyze({ path: projects, since: "nonsense" }));
    assert.equal(invalidAnalyze.value, 1);
    assert.match(invalidAnalyze.err, /invalid --since value/);

    const tune = computeGolemTune({ since: new Date("2026-04-01T00:00:00Z") });
    assert.ok(tune.sessionCount >= 2);
    assert.equal(tune.state.mode, "grunt");
    const tunePath = writeGolemTune(tune.state);
    assert.equal(tunePath, golemTunePath());

    const diff = await captureOut(() =>
      runDiff(["--tool", "mcp__fake__big", "--grep", "needle", "--tokenizer=heuristic", "--since=4w"]),
    );
    assert.equal(diff.value, 0);
    assert.match(diff.out, /applied rules:/);
    assert.match(diff.out, /response preview/);

    const diffBySession = await captureOut(() =>
      runDiff(["--session", "session-a", "--index", "2", "--tokenizer", "heuristic"]),
    );
    assert.equal(diffBySession.value, 0);
    assert.match(diffBySession.out, /mcp__fake__big/);

    const noDiff = await captureOut(() => runDiff(["--tool", "does-not-exist", "--since=1d"]));
    assert.equal(noDiff.value, 2);
    assert.match(noDiff.err, /no matching tool call/);

    const usage = await captureOut(() => runDiff([]));
    assert.equal(usage.value, 1);
    assert.match(usage.err, /Usage:/);
  });
});

test("graph query CLI and MCP handlers cover graph and Raven dispatch paths", async () => {
  await withTmpHome(async (home) => {
    writeConfig(home, { raven: { enabled: true, requires_codex: false } });
    const graphRepo = makeGraphRepo();
    const ravenRepo = makeGitRepo();
    try {
      const graphConfig = loadConfig(graphRepo.repo);
      const built = await buildGraph({ cwd: graphRepo.repo, config: graphConfig, force: true });
      assert.equal(built.ok, true, JSON.stringify(built));

      const minimal = await captureOut(() =>
        runGraphQuery({ cwd: graphRepo.repo, argv: ["minimal", "--file=src/foo.ts", "--depth=2"] }),
      );
      assert.equal(minimal.value, 0);
      assert.equal(JSON.parse(minimal.out).ok, true);

      const impact = await captureOut(() =>
        runGraphQuery({ cwd: graphRepo.repo, argv: ["impact", "--file", "src/foo.ts", "--symbols=foo", "--max-depth=2"] }),
      );
      assert.equal(impact.value, 0);
      assert.equal(JSON.parse(impact.out).ok, true);

      const review = await captureOut(() =>
        runGraphQuery({ cwd: graphRepo.repo, argv: ["review", "--files=src/foo.ts,src/index.ts"] }),
      );
      assert.equal(review.value, 0);
      assert.equal(JSON.parse(review.out).ok, true);

      const usages = await captureOut(() =>
        runGraphQuery({ cwd: graphRepo.repo, argv: ["usages", "--file=src/foo.ts", "--symbol=foo"] }),
      );
      assert.equal(usages.value, 0);
      assert.equal(JSON.parse(usages.out).ok, true);

      const invalid = await captureOut(() =>
        runGraphQuery({ cwd: graphRepo.repo, argv: ["minimal"] }),
      );
      assert.equal(invalid.value, 1);
      assert.equal(JSON.parse(invalid.out).reason, "invalid-input");

      const unknown = await captureOut(() =>
        runGraphQuery({ cwd: graphRepo.repo, argv: ["unknown"] }),
      );
      assert.equal(unknown.value, 1);
      assert.equal(JSON.parse(unknown.out).reason, "invalid-input");

      assert.equal((await dispatchGraphTool("get_minimal_context", {}, graphRepo.repo)).ok, false);
      assert.equal((await dispatchGraphTool("get_impact_radius", { changed: [] }, graphRepo.repo)).ok, false);
      assert.equal((await dispatchGraphTool("find_usages", {}, graphRepo.repo)).ok, false);
      assert.equal((await dispatchGraphTool("get_review_context", { files: [] }, graphRepo.repo)).ok, false);
      assert.equal((await dispatchGraphTool("find_oss_alternatives", { description: "" }, graphRepo.repo)).ok, false);

      const rebuild = await dispatchGraphTool("build_or_update_graph", { path: graphRepo.repo, force: true }, graphRepo.repo);
      assert.equal(rebuild.ok, true, JSON.stringify(rebuild));

      _resetQueryCacheForTests();
      const usageResult = await dispatchGraphTool(
        "find_usages",
        { target: { file: "src/foo.ts", symbol: "foo" } },
        graphRepo.repo,
      );
      assert.equal(usageResult.ok, true, JSON.stringify(usageResult));
      await dispatchGraphTool("find_usages", { target: { file: "src/foo.ts", symbol: "foo" } }, graphRepo.repo);
      assert.ok(_queryCacheSize() >= 1);
      assert.equal((await dispatchGraphTool("not_a_tool", {}, graphRepo.repo)).ok, false);

      const create = await dispatchGraphTool(
        "create_handoff_packet",
        { goal: "coverage review", target_agent: "codex", intent: "handoff" },
        ravenRepo.repo,
      );
      assert.equal(create.ok, true, JSON.stringify(create));
      const packet = (create as { ok: true; data: { packet: { packet_id: string } } }).data.packet;

      const read = await dispatchGraphTool("read_handoff_packet", { packet_id: packet.packet_id }, ravenRepo.repo);
      assert.equal(read.ok, true, JSON.stringify(read));
      assert.equal((await dispatchGraphTool("record_agent_review", { packet_id: packet.packet_id }, ravenRepo.repo)).ok, false);

      const firstReview = await dispatchGraphTool(
        "record_agent_review",
        {
          packet_id: packet.packet_id,
          agent: "codex",
          verdict: "needs-work",
          findings: [
            {
              severity: "high",
              file: "src/feature.ts",
              line: 1,
              title: "Feature math is suspicious",
              detail: "The changed constant needs a second look.",
            },
          ],
          questions: ["Should this stay dirty?"],
          suggested_tests: ["npm test"],
        },
        ravenRepo.repo,
      );
      assert.equal(firstReview.ok, true, JSON.stringify(firstReview));
      const reviewId = (firstReview as { ok: true; data: { review_id: string } }).data.review_id;

      const secondReview = await dispatchGraphTool(
        "record_agent_review",
        {
          packet_id: packet.packet_id,
          agent: "claude-code",
          verdict: "risky",
          findings: [
            {
              severity: "high",
              file: "src/feature.ts",
              line: 1,
              title: "Feature math is suspicious",
              detail: "The same risky change was found.",
            },
          ],
        },
        ravenRepo.repo,
      );
      assert.equal(secondReview.ok, true, JSON.stringify(secondReview));

      const list = await dispatchGraphTool("list_agent_reviews", { packet_id: packet.packet_id }, ravenRepo.repo);
      assert.equal(list.ok, true, JSON.stringify(list));
      const compare = await dispatchGraphTool("compare_agent_reviews", { packet_id: packet.packet_id }, ravenRepo.repo);
      assert.equal(compare.ok, true, JSON.stringify(compare));
      const readiness = await dispatchGraphTool("get_pr_readiness", { packet_id: packet.packet_id }, ravenRepo.repo);
      assert.equal(readiness.ok, true, JSON.stringify(readiness));

      const badDecision = await dispatchGraphTool("record_decision", { packet_id: packet.packet_id }, ravenRepo.repo);
      assert.equal(badDecision.ok, false);
      const decision = await dispatchGraphTool(
        "record_decision",
        {
          packet_id: packet.packet_id,
          decision: "fix-first",
          rationale: "High severity review finding is unresolved.",
          decided_by: "human",
          review_ids: [reviewId],
        },
        ravenRepo.repo,
      );
      assert.equal(decision.ok, true, JSON.stringify(decision));
    } finally {
      graphRepo.cleanup();
      ravenRepo.cleanup();
    }
  });
});

test("graph build source covers fail-open and incremental delta rebuild paths", async () => {
  await withTmpHome(async (home) => {
    writeConfig(home);
    const graphRepo = makeGraphRepo();
    const emptyRepo = mkdtempSync(join(tmpdir(), "tokenomy-empty-graph-"));
    try {
      const baseConfig = loadConfig(graphRepo.repo);
      const disabled = await buildGraph({
        cwd: graphRepo.repo,
        config: { ...baseConfig, graph: { ...baseConfig.graph, enabled: false } },
        force: true,
      });
      assert.equal(disabled.ok, false);
      if (!disabled.ok) assert.equal(disabled.reason, "graph-disabled");

      const noFiles = await buildGraph({
        cwd: emptyRepo,
        config: baseConfig,
        force: true,
      });
      assert.equal(noFiles.ok, false);
      if (!noFiles.ok) assert.equal(noFiles.reason, "no-files");

      const incrementalConfig = {
        ...baseConfig,
        graph: { ...baseConfig.graph, incremental: true },
      };
      const first = await buildGraph({ cwd: graphRepo.repo, config: incrementalConfig, force: true });
      assert.equal(first.ok, true, JSON.stringify(first));

      writeFileSync(
        join(graphRepo.repo, "src", "foo.ts"),
        [
          'import baz from "./baz";',
          "",
          "export const foo = () => baz() + String(Date.now()).slice(0, 0);",
          "",
        ].join("\n"),
        "utf8",
      );
      const delta = await buildGraph({ cwd: graphRepo.repo, config: incrementalConfig, force: false });
      assert.equal(delta.ok, true, JSON.stringify(delta));
      if (delta.ok) {
        assert.equal(delta.data.built, true);
        assert.equal(delta.stale, false);
        assert.deepEqual(delta.stale_files, []);
      }

      const fresh = await buildGraph({ cwd: graphRepo.repo, config: incrementalConfig, force: false });
      assert.equal(fresh.ok, true, JSON.stringify(fresh));
      if (fresh.ok) assert.equal(fresh.data.built, false);
    } finally {
      graphRepo.cleanup();
      rmSync(emptyRepo, { recursive: true, force: true });
    }
  });
});

test("raven CLI source commands cover repo, packet, and command install paths", async () => {
  await withTmpHome(async (home) => {
    writeConfig(home, { raven: { enabled: true, requires_codex: false } });
    const { repo, cleanup } = makeGitRepo();
    try {
      await withCwd(repo, async () => {
        const status = await captureOut(() => runRaven(["status"]));
        assert.equal(status.value, 0);
        assert.match(status.out, /Raven: enabled/);

        const brief = await captureOut(() =>
          runRaven(["brief", "--goal=coverage", "--target=human", "--json"]),
        );
        assert.equal(brief.value, 0);
        const packet = JSON.parse(brief.out) as { packet_id: string; git: { changed_files: string[] } };
        assert.match(packet.packet_id, /^raven-packet-/);
        assert.ok(packet.git.changed_files.includes("src/feature.ts"));

        const compare = await captureOut(() => runRaven(["compare", "--json"]));
        assert.equal(compare.value, 1);
        assert.match(compare.err, /no-reviews/);

        const prCheck = await captureOut(() => runRaven(["pr-check", "--json"]));
        assert.equal(prCheck.value, 2);
        assert.match(prCheck.out, /No reviews recorded/);

        const install = await captureOut(() => runRaven(["install-commands"]));
        assert.equal(install.value, 0);
        assert.equal(existsSync(join(repo, ".claude", "commands", "raven-brief.md")), true);
        const installAgain = await captureOut(() => runRaven(["install-commands"]));
        assert.equal(installAgain.value, 1);
        assert.match(installAgain.err, /already exists/);

        const clean = await captureOut(() => runRaven(["clean", "--dry-run", "--keep=1", "--older-than=1d"]));
        assert.equal(clean.value, 0);
        assert.match(clean.out, /Would remove/);

        const disabled = await captureOut(() => runRaven(["disable", "--purge"]));
        assert.equal(disabled.value, 0);
        assert.match(disabled.out, /Raven disabled/);

        const help = await captureOut(() => runRaven(["bogus"]));
        assert.equal(help.value, 1);
        assert.match(help.err, /Usage:/);
      });
    } finally {
      cleanup();
    }
  });
});

test("update source command uses fake npm and preserves graph init path", async () => {
  await withTmpHome(async (home) => {
    writeConfig(home);
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    const npmArgsFile = join(home, "npm-args.txt");
    const tokenomyArgsFile = join(home, "tokenomy-args.txt");
    writeFileSync(
      join(bin, "npm"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"view\" ]; then printf '%s\\n' \"${FAKE_NPM_VERSION:-9.9.9}\"; exit 0; fi",
        "if [ \"$1\" = \"install\" ]; then printf '%s\\n' \"$*\" > \"$FAKE_NPM_ARGS\"; exit 0; fi",
        "exit 3",
      ].join("\n") + "\n",
      "utf8",
    );
    writeFileSync(
      join(bin, "tokenomy"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$FAKE_TOKENOMY_ARGS\"",
        "exit 0",
      ].join("\n") + "\n",
      "utf8",
    );
    chmodSync(join(bin, "npm"), 0o755);
    chmodSync(join(bin, "tokenomy"), 0o755);

    const graphPath = join(home, "graph-repo");
    mkdirSync(graphPath, { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "tokenomy-graph": {
            command: "tokenomy",
            args: ["graph", "serve", "--path", graphPath],
          },
        },
      }) + "\n",
      "utf8",
    );

    const prevPath = process.env["PATH"];
    const prevNpmVersion = process.env["FAKE_NPM_VERSION"];
    const prevNpmArgs = process.env["FAKE_NPM_ARGS"];
    const prevTokenomyArgs = process.env["FAKE_TOKENOMY_ARGS"];
    process.env["PATH"] = `${bin}:${prevPath ?? ""}`;
    process.env["FAKE_NPM_ARGS"] = npmArgsFile;
    process.env["FAKE_TOKENOMY_ARGS"] = tokenomyArgsFile;
    try {
      process.env["FAKE_NPM_VERSION"] = "9.9.9";
      const check = await captureOut(() => runUpdate({ check: true, tag: "latest" }));
      assert.equal(check.value, 1);
      assert.match(check.out, /Update available/);
      assert.equal(existsSync(updateCachePath()), true);

      process.env["FAKE_NPM_VERSION"] = TOKENOMY_VERSION;
      const pinned = await captureOut(() => runUpdate({ check: true, version: TOKENOMY_VERSION }));
      assert.equal(pinned.value, 0);
      assert.match(pinned.out, /Up to date/);

      process.env["FAKE_NPM_VERSION"] = "9.9.9";
      const updated = await captureOut(() => runUpdate({ force: true, tag: "latest" }));
      assert.equal(updated.value, 0);
      assert.match(updated.out, /Re-staging hook \+ config \+ graph/);
      assert.match(readFileSync(npmArgsFile, "utf8"), /install -g tokenomy@latest/);
      assert.match(readFileSync(tokenomyArgsFile, "utf8"), new RegExp(`init --graph-path=${graphPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    } finally {
      if (prevPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = prevPath;
      if (prevNpmVersion === undefined) delete process.env["FAKE_NPM_VERSION"];
      else process.env["FAKE_NPM_VERSION"] = prevNpmVersion;
      if (prevNpmArgs === undefined) delete process.env["FAKE_NPM_ARGS"];
      else process.env["FAKE_NPM_ARGS"] = prevNpmArgs;
      if (prevTokenomyArgs === undefined) delete process.env["FAKE_TOKENOMY_ARGS"];
      else process.env["FAKE_TOKENOMY_ARGS"] = prevTokenomyArgs;
    }
  });
});

test("bench and learn source CLIs cover report, compare, and proposal application", async () => {
  await withTmpHome(async (home) => {
    writeConfig(home);
    const runJson = await captureOut(() => runBenchCli(["run", "golem-output-mode", "--json"]));
    assert.equal(runJson.value, 0);
    const before = JSON.parse(runJson.out) as { total_tokens_saved: number };
    assert.ok(before.total_tokens_saved > 0);

    const report = await captureOut(() => runBenchCli(["report", "shell-trace-trim"]));
    assert.equal(report.value, 0);
    assert.match(report.out, /shell-trace-trim/);

    const a = join(home, "before.json");
    const b = join(home, "after.json");
    writeFileSync(a, JSON.stringify({ total_tokens_saved: 10 }), "utf8");
    writeFileSync(b, JSON.stringify({ total_tokens_saved: 35 }), "utf8");
    const compare = await captureOut(() => runBenchCli(["compare", a, b]));
    assert.equal(compare.value, 0);
    assert.match(compare.out, /tokens_saved_delta: \+25/);

    const badCompare = await captureOut(() => runBenchCli(["compare", a, join(home, "missing.json")]));
    assert.equal(badCompare.value, 1);
    assert.match(badCompare.err, /Usage:/);

    const help = await captureOut(() => runBenchCli(["help"]));
    assert.equal(help.value, 0);
    assert.match(help.out, /tokenomy bench run/);

    const events: string[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(jsonLine({ ts: "2026-04-18T10:00:00Z", session_id: `s-bash-${i}`, tool: "Bash", bytes_in: 1000, bytes_out: 100, tokens_saved_est: 500, reason: "bash-bound:mytool" }));
    }
    for (let i = 0; i < 20; i++) {
      events.push(jsonLine({ ts: "2026-04-18T10:00:00Z", session_id: `s-read-${i}`, tool: "Read", bytes_in: 10000, bytes_out: 100, tokens_saved_est: 3000, reason: "read-clamp" }));
    }
    for (let i = 0; i < 3; i++) {
      events.push(jsonLine({ ts: "2026-04-18T10:00:00Z", session_id: `s-redact-${i}`, tool: "mcp__fake__big", bytes_in: 10000, bytes_out: 100, tokens_saved_est: 3000, reason: "mcp-trim redact:1" }));
    }
    writeFileSync(join(home, ".tokenomy", "savings.jsonl"), events.join("\n") + "\n", "utf8");

    const learn = await captureOut(() => runLearn(["--since=30d"]));
    assert.equal(learn.value, 0);
    assert.match(learn.out, /bash-custom-mytool/);
    assert.match(learn.out, /read-raise-injected-limit/);
    assert.match(learn.out, /redact-enable-pre-tool-use/);

    const applied = await captureOut(() => runLearn(["--since", "30d", "--apply"]));
    assert.equal(applied.value, 0);
    assert.match(applied.out, /Applied 3 patches/);
    const cfg = JSON.parse(readFileSync(join(home, ".tokenomy", "config.json"), "utf8"));
    assert.deepEqual(cfg.bash.custom_verbose, ["mytool"]);
    assert.equal(cfg.read.injected_limit, 750);
    assert.equal(cfg.redact.pre_tool_use, true);
  });
});

test("entry source subprocess covers top-level argument dispatch branches", async () => {
  await withTmpHome(async (home) => {
    const emptyProjects = join(home, ".claude", "projects");
    mkdirSync(emptyProjects, { recursive: true });
    writeConfig(home);
    const runEntry = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "src", "cli", "entry.ts"), ...args], {
        cwd: ROOT,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    const help = runEntry([]);
    assert.equal(help.status, 1);
    assert.match(help.stdout, /tokenomy/);

    const version = runEntry(["--version"]);
    assert.equal(version.status, 0);
    assert.match(version.stdout, new RegExp(`tokenomy ${TOKENOMY_VERSION}`));

    const listAgents = runEntry(["init", "--list-agents"]);
    assert.equal(listAgents.status, 0);
    assert.match(listAgents.stdout, /claude-code/);

    const badAgent = runEntry(["init", "--agent=not-real"]);
    assert.equal(badAgent.status, 1);
    assert.match(badAgent.stderr, /unknown --agent/);

    const configUsage = runEntry(["config"]);
    assert.equal(configUsage.status, 1);
    assert.match(configUsage.stderr, /Usage: tokenomy config/);

    const updateUsage = runEntry(["update", "--version"]);
    assert.equal(updateUsage.status, 1);
    assert.match(updateUsage.stderr, /--version requires a value/);

    const badTop = runEntry(["analyze", "--path", emptyProjects, "--top=0", "--json", "--tokenizer=heuristic"]);
    assert.equal(badTop.status, 0);
    assert.match(badTop.stderr, /--top must be a positive integer/);
    assert.equal(JSON.parse(badTop.stdout).totals.tool_calls, 0);

    const unknown = runEntry(["unknown"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown command/);
  });
});
