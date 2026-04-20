import { test } from "node:test";
import assert from "node:assert/strict";
import { bashBoundRule } from "../../src/rules/bash-bound.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { Config } from "../../src/core/types.js";

// Balanced aggression → head_limit = 100 (unscaled default). Makes assertions
// deterministic across default/conservative/aggressive modes.
const cfg = (over: Partial<Config["bash"]> = {}): Config => ({
  ...DEFAULT_CONFIG,
  aggression: "balanced",
  bash: { ...DEFAULT_CONFIG.bash, ...over },
});

const run = (command: string, c: Config = cfg()) =>
  bashBoundRule({ command }, c);

// ————————————————————————————————————————————————————————————————
// Passthroughs
// ————————————————————————————————————————————————————————————————

test("bash-bound: passthrough when cfg.bash.enabled=false", () => {
  const r = run("git log", cfg({ enabled: false }));
  assert.equal(r.kind, "passthrough");
  assert.equal(r.reason, "disabled");
});

test("bash-bound: passthrough when command missing", () => {
  const r = bashBoundRule({}, cfg());
  assert.equal(r.kind, "passthrough");
});

test("bash-bound: passthrough when command not a string", () => {
  const r = bashBoundRule({ command: 42 as unknown as string }, cfg());
  assert.equal(r.kind, "passthrough");
});

test("bash-bound: passthrough below min_command_length", () => {
  const r = run("gl");
  assert.equal(r.kind, "passthrough");
  assert.equal(r.reason, "too-short");
});

test("bash-bound: passthrough when run_in_background=true", () => {
  const r = bashBoundRule({ command: "git log", run_in_background: true }, cfg());
  assert.equal(r.kind, "passthrough");
  assert.equal(r.reason, "run-in-background");
});

test("bash-bound: rejects shell-injection head_limit ('200; touch evil')", () => {
  const bad = { ...DEFAULT_CONFIG.bash, head_limit: "200; touch /tmp/evil" as unknown as number };
  const r = bashBoundRule({ command: "git log" }, { ...DEFAULT_CONFIG, aggression: "balanced", bash: bad });
  assert.equal(r.kind, "passthrough");
  assert.equal(r.reason, "invalid-head-limit");
});

test("bash-bound: rejects out-of-band head_limit (too small)", () => {
  const r = run("git log", cfg({ head_limit: 10 }));
  assert.equal(r.kind, "passthrough");
});

test("bash-bound: rejects out-of-band head_limit (too large)", () => {
  const r = run("git log", cfg({ head_limit: 50_000 }));
  assert.equal(r.kind, "passthrough");
});

test("bash-bound: already-bounded -n N / --max-count / -n<digits>", () => {
  for (const c of [
    "git log -n 5",
    "git log -n5",
    "git log --max-count=10",
    "git log --max-count 10",
    "git log | head -20",
    "git log | tail -20",
    "git log | wc -l",
    "find . -maxdepth 3",
    "journalctl --lines 100",
    "docker logs --tail 50 svc",
    "npm ls --depth 0",
  ]) {
    const r = run(c);
    assert.equal(r.kind, "passthrough", `expected passthrough for: ${c}`);
  }
});

test("bash-bound: passthrough on redirect / compound / subshell / heredoc", () => {
  for (const c of [
    "git log > /tmp/out",
    "git log >> /tmp/out",
    "git log && echo done",
    "git log || true",
    "git log ; ls",
    "echo $(git log)",
    "echo `git log`",
    "git log &",
    "git log 2>&1 >/tmp/out",
    "cat <<EOF\nhi\nEOF",
  ]) {
    const r = run(c);
    assert.equal(r.kind, "passthrough", `expected passthrough for: ${c}`);
  }
});

test("bash-bound: trailing shell comment stripped + command bound", () => {
  for (const [input, expectPattern] of [
    ["git log # debug note", "git-log"],
    ["find /tmp # scanning", "find"],
    ["ps aux  #   process dump", "ps"],
  ] as const) {
    const r = run(input);
    assert.equal(r.kind, "bound", `expected bound for: ${input} (got reason=${r.reason})`);
    if (r.kind !== "bound") continue;
    assert.equal(r.patternName, expectPattern);
    // Rewritten command must NOT contain the comment `#` at all.
    assert.ok(!r.boundedCommand?.includes("#"), `unexpected # in: ${r.boundedCommand}`);
    // And must still be the clean pipefail/awk form.
    assert.ok(r.boundedCommand?.startsWith("set -o pipefail; "));
    assert.ok(r.boundedCommand?.endsWith(" | awk 'NR<=100'"));
  }
});

test("bash-bound: # inside quotes is preserved (not treated as comment)", () => {
  // If the user quoted a # it's a literal — we must not strip.
  // `echo "foo # bar"` isn't verbose so stays passthrough, but we prove
  // stripTrailingComment doesn't mangle it via the quoted-# inside a
  // verbose-pattern command.
  const r = run(`git log --format='%H # %s'`);
  // Already-bounded check may or may not catch `--format`; core invariant
  // is: no mis-strip of the internal `#`.
  if (r.kind === "bound") {
    assert.ok(r.boundedCommand?.includes("'%H # %s'"));
  }
});

test("bash-bound: command that becomes empty after comment strip stays passthrough", () => {
  const r = run("# just a comment");
  assert.equal(r.kind, "passthrough");
});

test("bash-bound: passthrough on tool-specific native bound flags", () => {
  for (const c of [
    // git log shorthand: -20 == -n20
    "git log -20",
    "git log --oneline -5",
    // git show -10
    "git show -10",
    // tree depth limit
    "tree -L 2",
    "tree -L2",
  ]) {
    const r = run(c);
    assert.equal(r.kind, "passthrough", `expected passthrough for: ${c}`);
  }
});

test("bash-bound: passthrough on user-owned pipelines (find | xargs rm)", () => {
  for (const c of [
    "find . | xargs rm",
    "git log | grep foo",
    "ps aux | awk '{print $1}'",
    "find /tmp | sort | uniq",
  ]) {
    const r = run(c);
    assert.equal(r.kind, "passthrough", `expected passthrough for: ${c}`);
  }
});

test("bash-bound: passthrough on exit-status-sensitive built-ins", () => {
  // Defaults must NOT bind these — they're routinely used as exit probes.
  for (const c of ["git diff --exit-code", "npm ls", "git status --porcelain"]) {
    const r = run(c);
    assert.equal(r.kind, "passthrough", `expected passthrough for: ${c}`);
  }
});

test("bash-bound: passthrough on find side-effects", () => {
  for (const c of [
    "find . -exec rm {} +",
    "find . -delete",
    "find . -print0",
    "find . -okdir rm {} \\;",
    "find . -type f -exec grep foo {} \\;",
  ]) {
    const r = run(c);
    assert.equal(r.kind, "passthrough", `expected passthrough for: ${c}`);
  }
});

test("bash-bound: passthrough on streaming / interactive commands", () => {
  for (const c of [
    "tail -f /var/log/x",
    "docker logs -f svc",
    "journalctl --follow",
    "kubectl logs -f pod",
    "watch -n1 ls",
    "top",
    "htop",
    "less /var/log/big",
  ]) {
    const r = run(c);
    assert.equal(r.kind, "passthrough", `expected passthrough for: ${c}`);
  }
});

test("bash-bound: passthrough on unknown / short verbless commands", () => {
  for (const c of ["echo hello", "pwd", "ls", "cat /tmp/file", "which node"]) {
    const r = run(c);
    assert.equal(r.kind, "passthrough", `expected passthrough for: ${c}`);
  }
});

// ————————————————————————————————————————————————————————————————
// Bindings
// ————————————————————————————————————————————————————————————————

const assertBound = (command: string, patternName: string, head_limit = 100) => {
  const r = run(command, cfg({ head_limit }));
  assert.equal(r.kind, "bound", `expected bound for: ${command} (got reason=${r.reason})`);
  if (r.kind !== "bound") return;
  assert.equal(r.patternName, patternName);
  assert.equal(r.boundedCommand?.startsWith("set -o pipefail; "), true);
  assert.equal(r.boundedCommand?.endsWith(` | awk 'NR<=${head_limit}'`), true);
};

test("bash-bound: binds git log / git show", () => {
  assertBound("git log", "git-log");
  assertBound("git log --oneline", "git-log");
  assertBound("git show HEAD", "git-show");
});

test("bash-bound: binds find with safe actions only", () => {
  assertBound("find /tmp", "find");
  assertBound("find /tmp -type f", "find");
  assertBound("find /tmp -type f -print", "find");
});

test("bash-bound: binds recursive ls", () => {
  assertBound("ls -R /", "ls-recursive");
  assertBound("ls -lR /usr", "ls-recursive");
  assertBound("ls -aR .", "ls-recursive");
});

test("bash-bound: binds ps aux / -ef", () => {
  assertBound("ps aux", "ps");
  assertBound("ps auxww", "ps");
  assertBound("ps -ef", "ps");
});

test("bash-bound: binds docker logs / journalctl / kubectl logs", () => {
  assertBound("docker logs my-container", "docker-logs");
  assertBound("journalctl", "journalctl");
  assertBound("kubectl logs my-pod", "kubectl-logs");
});

test("bash-bound: binds tree", () => {
  assertBound("tree", "tree");
});

test("bash-bound: peels leading sudo / time / env assignments", () => {
  assertBound("sudo git log", "git-log");
  assertBound("time git log", "git-log");
  assertBound("FOO=bar git log", "git-log");
  assertBound("FOO=bar BAZ=qux git log", "git-log");
});

test("bash-bound: custom_verbose prefix matches", () => {
  const c = cfg({ custom_verbose: ["flamegraph", "strace"] });
  const r = bashBoundRule({ command: "flamegraph --rate 999 target" }, c);
  assert.equal(r.kind, "bound");
  if (r.kind !== "bound") return;
  assert.equal(r.patternName, "flamegraph");
});

test("bash-bound: disabled_commands skips specific pattern", () => {
  const c = cfg({ disabled_commands: ["git-log"] });
  const r = bashBoundRule({ command: "git log" }, c);
  assert.equal(r.kind, "passthrough");
  assert.equal(r.reason, "user-disabled");
});

test("bash-bound: preserves sibling fields (timeout, description)", () => {
  const r = bashBoundRule(
    { command: "git log", timeout: 30000, description: "view history" },
    cfg(),
  );
  assert.equal(r.kind, "bound");
  if (r.kind !== "bound") return;
  const u = r.updatedInput as Record<string, unknown>;
  assert.equal(u["timeout"], 30000);
  assert.equal(u["description"], "view history");
});

test("bash-bound: does not mutate original toolInput", () => {
  const input = { command: "git log", timeout: 1000 };
  const snap = JSON.parse(JSON.stringify(input));
  bashBoundRule(input, cfg());
  assert.deepEqual(input, snap);
});

test("bash-bound: additionalContext mentions native flag for pattern", () => {
  const r = run("git log", cfg({ head_limit: 200 }));
  assert.equal(r.kind, "bound");
  if (r.kind !== "bound") return;
  assert.ok(r.additionalContext?.includes("--max-count="));
  assert.ok(r.additionalContext?.includes("200"));
});
