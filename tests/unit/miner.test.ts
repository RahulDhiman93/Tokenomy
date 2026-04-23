import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mineProposals } from "../../src/analyze/miner.js";
import { applyProposals } from "../../src/core/config-writer.js";
import { defaultLogPath, globalConfigPath } from "../../src/core/paths.js";

const setupHome = () => {
  const dir = join(tmpdir(), `tokenomy-miner-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const prev = process.env["HOME"];
  process.env["HOME"] = dir;
  return {
    home: dir,
    restore: () => {
      if (prev === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prev;
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    },
  };
};

const seedLog = (entries: Array<Record<string, unknown>>): void => {
  const path = defaultLogPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
};

test("miner: empty log → no proposals", () => {
  const h = setupHome();
  try {
    assert.equal(mineProposals(undefined).length, 0);
  } finally {
    h.restore();
  }
});

test("miner: custom bash pattern firing ≥3× is proposed for custom_verbose", () => {
  const h = setupHome();
  try {
    const now = new Date().toISOString();
    seedLog([
      { ts: now, session_id: "s", tool: "Bash", bytes_in: 0, bytes_out: 0, tokens_saved_est: 100, reason: "bash-bound:flamegraph" },
      { ts: now, session_id: "s", tool: "Bash", bytes_in: 0, bytes_out: 0, tokens_saved_est: 100, reason: "bash-bound:flamegraph" },
      { ts: now, session_id: "s", tool: "Bash", bytes_in: 0, bytes_out: 0, tokens_saved_est: 100, reason: "bash-bound:flamegraph" },
    ]);
    const proposals = mineProposals(undefined);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]!.id, "bash-custom-flamegraph");
    assert.equal(proposals[0]!.patch.path, "bash.custom_verbose");
    assert.equal(proposals[0]!.patch.op, "append");
    assert.equal(proposals[0]!.patch.value, "flamegraph");
  } finally {
    h.restore();
  }
});

test("miner: built-in pattern firings don't produce a proposal", () => {
  const h = setupHome();
  try {
    const now = new Date().toISOString();
    seedLog(
      Array(10).fill(0).map(() => ({
        ts: now,
        session_id: "s",
        tool: "Bash",
        bytes_in: 0,
        bytes_out: 0,
        tokens_saved_est: 100,
        reason: "bash-bound:git-log",
      })),
    );
    const proposals = mineProposals(undefined);
    assert.equal(proposals.length, 0);
  } finally {
    h.restore();
  }
});

test("applyProposals: writes config + creates backup on existing file", () => {
  const h = setupHome();
  try {
    const path = globalConfigPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ aggression: "conservative" }), "utf8");
    const result = applyProposals([
      { path: "bash.custom_verbose", op: "append", value: "flamegraph" },
      { path: "redact.pre_tool_use", op: "add", value: true },
    ]);
    assert.ok(existsSync(result.config_path));
    assert.ok(existsSync(result.backup_path));
    const written = JSON.parse(readFileSync(result.config_path, "utf8"));
    assert.deepEqual(written.bash.custom_verbose, ["flamegraph"]);
    assert.equal(written.redact.pre_tool_use, true);
    // Backup preserves original.
    const backup = JSON.parse(readFileSync(result.backup_path, "utf8"));
    assert.equal(backup.aggression, "conservative");
    assert.equal(backup.bash, undefined);
  } finally {
    h.restore();
  }
});

test("applyProposals: dedupes append values", () => {
  const h = setupHome();
  try {
    const path = globalConfigPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ bash: { custom_verbose: ["foo"] } }), "utf8");
    applyProposals([{ path: "bash.custom_verbose", op: "append", value: "foo" }]);
    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(written.bash.custom_verbose, ["foo"]);
  } finally {
    h.restore();
  }
});
