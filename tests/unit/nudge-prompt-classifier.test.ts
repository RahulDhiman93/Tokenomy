import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyPromptRule } from "../../src/rules/prompt-classifier.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import type { Config } from "../../src/core/types.js";

const cfgWith = (patch: (c: Config) => Config): Config =>
  patch(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));

// Seeds a tmp graph root + meta.json pair so the repo-aware intents
// (change / remove / review) don't short-circuit on missing graph. The
// classifier resolves the repo id from cwd, so we mirror its expectation.
const withFakeGraph = <T>(fn: (cwd: string) => T): T => {
  const cwd = mkdtempSync(join(tmpdir(), "tok-classifier-"));
  const home = mkdtempSync(join(tmpdir(), "tok-classifier-home-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    spawnSync("git", ["init", "-q"], { cwd });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd });
    spawnSync("git", ["config", "user.name", "T"], { cwd });
    writeFileSync(join(cwd, "seed.txt"), "hi");
    spawnSync("git", ["add", "."], { cwd });
    spawnSync("git", ["commit", "-q", "-m", "seed"], { cwd });

    const { repoId } = resolveRepoId(cwd);
    const graphDir = join(home, ".tokenomy", "graphs", repoId);
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, "meta.json"), "{}");

    return fn(cwd);
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
};

test("classifyPromptRule: build intent nudges toward find_oss_alternatives", () => {
  const cfg = DEFAULT_CONFIG;
  const r = classifyPromptRule(
    "Build a retry-with-backoff wrapper for our fetch calls.",
    cfg,
    process.cwd(),
  );
  assert.equal(r.kind, "nudge");
  assert.equal(r.intent, "build");
  assert.match(r.additionalContext ?? "", /find_oss_alternatives/);
  assert.match(r.additionalContext ?? "", /tokenomy-nudge \(build\)/);
});

test("classifyPromptRule: change intent nudges toward find_usages + get_impact_radius", () => {
  withFakeGraph((cwd) => {
    const r = classifyPromptRule(
      "Let's refactor the useRuntimeConfig hook to support async loading.",
      DEFAULT_CONFIG,
      cwd,
    );
    assert.equal(r.kind, "nudge");
    assert.equal(r.intent, "change");
    assert.match(r.additionalContext ?? "", /find_usages/);
    assert.match(r.additionalContext ?? "", /get_impact_radius/);
  });
});

test("classifyPromptRule: remove intent nudges toward get_impact_radius", () => {
  withFakeGraph((cwd) => {
    const r = classifyPromptRule(
      "I want to remove the legacy auth middleware — what's the blast radius?",
      DEFAULT_CONFIG,
      cwd,
    );
    assert.equal(r.kind, "nudge");
    assert.equal(r.intent, "remove");
    assert.match(r.additionalContext ?? "", /get_impact_radius/);
  });
});

test("classifyPromptRule: review intent nudges toward get_review_context", () => {
  withFakeGraph((cwd) => {
    const r = classifyPromptRule(
      "Please review the changes on this branch and highlight what might regress.",
      DEFAULT_CONFIG,
      cwd,
    );
    assert.equal(r.kind, "nudge");
    assert.equal(r.intent, "review");
    assert.match(r.additionalContext ?? "", /get_review_context/);
  });
});

test("classifyPromptRule: passthrough when nudge disabled", () => {
  const cfg = cfgWith((c) => {
    if (c.nudge) c.nudge.enabled = false;
    return c;
  });
  const r = classifyPromptRule("Build a retry helper at src/utils/retry.ts", cfg, process.cwd());
  assert.equal(r.kind, "passthrough");
});

test("classifyPromptRule: passthrough when classifier disabled", () => {
  const cfg = cfgWith((c) => {
    if (c.nudge) c.nudge.prompt_classifier.enabled = false;
    return c;
  });
  const r = classifyPromptRule("Build a retry helper at src/utils/retry.ts", cfg, process.cwd());
  assert.equal(r.kind, "passthrough");
});

test("classifyPromptRule: passthrough on prompts shorter than min_prompt_chars", () => {
  const r = classifyPromptRule("build X", DEFAULT_CONFIG, process.cwd());
  assert.equal(r.kind, "passthrough");
});

test("classifyPromptRule: passthrough when prompt already mentions the tool", () => {
  const r = classifyPromptRule(
    "Call mcp__tokenomy-graph__find_oss_alternatives before building retry.",
    DEFAULT_CONFIG,
    process.cwd(),
  );
  assert.equal(r.kind, "passthrough");
});

test("classifyPromptRule: passthrough on neutral conversational prompts", () => {
  const r = classifyPromptRule(
    "Thanks, that looks good to me — any gotchas I should know about?",
    DEFAULT_CONFIG,
    process.cwd(),
  );
  assert.equal(r.kind, "passthrough");
});

test("classifyPromptRule: skips git-noun false positives (create a commit/branch/PR)", () => {
  for (const phrase of [
    "create a commit with the changes so far",
    "make a new branch for the refactor work",
    "write a PR description summarizing the change",
  ]) {
    const r = classifyPromptRule(phrase, DEFAULT_CONFIG, process.cwd());
    // These should NOT trigger the build intent because the noun following
    // the verb is git-shaped, not code-shaped.
    if (r.kind === "nudge") {
      // A "change"/"refactor"/"review" intent may still trigger legitimately
      // (phrase 2 mentions "refactor"; phrase 3 mentions "summarizing"), but
      // the build intent specifically must not fire here.
      assert.notEqual(r.intent, "build", `false-positive build on: ${phrase}`);
    }
  }
});

test("classifyPromptRule: graph-dependent intents skip when no graph snapshot exists", () => {
  // Use a tmp cwd that has no graph seeded — change/remove/review should
  // passthrough even though the verbs match.
  const cwd = mkdtempSync(join(tmpdir(), "tok-no-graph-"));
  const home = mkdtempSync(join(tmpdir(), "tok-no-graph-home-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const r = classifyPromptRule(
      "Let's refactor the whole auth layer to use the new session API.",
      DEFAULT_CONFIG,
      cwd,
    );
    assert.equal(r.kind, "passthrough");
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("classifyPromptRule: build intent fires without a graph snapshot (OSS tool is graph-independent)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "tok-build-no-graph-"));
  const home = mkdtempSync(join(tmpdir(), "tok-build-no-graph-home-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    const r = classifyPromptRule(
      "Let's build a schema validator for our API inputs.",
      DEFAULT_CONFIG,
      cwd,
    );
    assert.equal(r.kind, "nudge");
    assert.equal(r.intent, "build");
  } finally {
    if (prevHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prevHome;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("classifyPromptRule: per-intent toggle silences just that intent", () => {
  const cfg = cfgWith((c) => {
    if (c.nudge) c.nudge.prompt_classifier.intents.build = false;
    return c;
  });
  const r = classifyPromptRule(
    "Let's build a rate limiter for the API gateway.",
    cfg,
    process.cwd(),
  );
  assert.equal(r.kind, "passthrough");
});
