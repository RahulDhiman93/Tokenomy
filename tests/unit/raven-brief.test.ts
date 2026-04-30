import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPacketFresh,
  buildRavenPacket,
  createAndSaveRavenPacket,
  packetDigest,
} from "../../src/raven/brief.js";
import { loadConfig } from "../../src/core/config.js";
import { buildGraph } from "../../src/graph/build.js";
import type { RavenPacket } from "../../src/raven/schema.js";

const runGit = (cwd: string, args: string[]): void => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
};

const initRepo = (): { repo: string; home: string; cleanup: () => void } => {
  // Tokenomy config lives under HOME — isolate it so cfg.raven.enabled
  // doesn't depend on whatever the host user has set.
  const home = mkdtempSync(join(tmpdir(), "tokenomy-raven-brief-home-"));
  const prevHome = process.env["HOME"];
  process.env["HOME"] = home;
  mkdirSync(join(home, ".tokenomy"), { recursive: true });
  // Enable raven so buildRavenPacket doesn't bail early.
  writeFileSync(
    join(home, ".tokenomy", "config.json"),
    JSON.stringify({ raven: { enabled: true } }),
  );
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-raven-brief-"));
  runGit(repo, ["init", "-b", "main"]);
  runGit(repo, ["config", "user.name", "Test"]);
  runGit(repo, ["config", "user.email", "t@x.test"]);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "init"]);
  // Add a feature branch with a committed file so the packet has a footprint.
  runGit(repo, ["checkout", "-b", "feature/x"]);
  writeFileSync(join(repo, "src", "feature.ts"), "export const f = 2;\n");
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-m", "add feature"]);
  return {
    repo,
    home,
    cleanup: () => {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
};

test("buildRavenPacket: returns ok with packet + markdown for a real git repo", () => {
  const { repo, cleanup } = initRepo();
  try {
    const result = buildRavenPacket({
      cwd: repo,
      goal: "second-opinion review",
      sourceAgent: "claude-code",
      targetAgent: "codex",
      intent: "review",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    const packet = result.data.packet;
    assert.equal(packet.schema_version, 1);
    assert.equal(packet.repo.branch, "feature/x");
    assert.equal(packet.target?.agent, "codex");
    assert.equal(packet.target?.intent, "review");
    assert.equal(packet.goal, "second-opinion review");
    assert.equal(packet.repo.base_ref, "main");
    assert.ok(packet.git.changed_files.includes("src/feature.ts"));
    assert.match(result.data.markdown, /# Tokenomy Raven Packet/);
  } finally {
    cleanup();
  }
});

test("buildRavenPacket: graph context surfaces last build failure when snapshot is missing", async () => {
  const { repo, home, cleanup } = initRepo();
  try {
    writeFileSync(
      join(home, ".tokenomy", "config.json"),
      JSON.stringify({ raven: { enabled: true }, graph: { max_snapshot_bytes: 1 } }),
    );
    const built = await buildGraph({ cwd: repo, force: true, config: loadConfig(repo) });
    assert.equal(built.ok, false);
    if (!built.ok) assert.equal(built.reason, "graph-too-large");

    const packet = buildRavenPacket({ cwd: repo, intent: "review" });
    assert.equal(packet.ok, true, JSON.stringify(packet));
    if (!packet.ok) return;
    const review = packet.data.packet.graph?.review_context as { ok?: boolean; reason?: string; hint?: string };
    const impact = packet.data.packet.graph?.impact_radius as { ok?: boolean; reason?: string; hint?: string };
    assert.equal(review.ok, false);
    assert.equal(review.reason, "graph-too-large");
    assert.match(review.hint ?? "", /graph\.max_snapshot_bytes/);
    assert.equal(impact.ok, false);
    assert.equal(impact.reason, "graph-too-large");
  } finally {
    cleanup();
  }
});

test("buildRavenPacket: refuses when raven is disabled in config", () => {
  const { repo, home, cleanup } = initRepo();
  try {
    // Flip raven.enabled back to false at runtime.
    writeFileSync(
      join(home, ".tokenomy", "config.json"),
      JSON.stringify({ raven: { enabled: false } }),
    );
    const result = buildRavenPacket({ cwd: repo });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "raven-disabled");
  } finally {
    cleanup();
  }
});

test("buildRavenPacket: returns the wrapped git error when cwd isn't a repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "tokenomy-raven-not-a-repo-"));
  try {
    const result = buildRavenPacket({ cwd: tmp });
    assert.equal(result.ok, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("createAndSaveRavenPacket: writes packet + latest pointer to disk", () => {
  const { repo, cleanup } = initRepo();
  try {
    const result = createAndSaveRavenPacket({
      cwd: repo,
      sourceAgent: "claude-code",
      intent: "handoff",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.data.path, /raven/);
    assert.match(result.data.packet.packet_id, /^raven-packet-/);
  } finally {
    cleanup();
  }
});

test("assertPacketFresh: passes when packet head matches; fails on mismatch", () => {
  const { repo, cleanup } = initRepo();
  try {
    const built = buildRavenPacket({ cwd: repo });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const fresh = assertPacketFresh(built.data.packet, repo);
    assert.equal(fresh.ok, true);
    // Mutate the head sha → stale.
    const stale: RavenPacket = {
      ...built.data.packet,
      repo: { ...built.data.packet.repo, head_sha: "0".repeat(40) },
    };
    const stale1 = assertPacketFresh(stale, repo);
    assert.equal(stale1.ok, false);
    if (!stale1.ok) assert.equal(stale1.reason, "stale-packet");
  } finally {
    cleanup();
  }
});

test("packetDigest: produces a stable 16-char hex hash", () => {
  const { repo, cleanup } = initRepo();
  try {
    const built = buildRavenPacket({ cwd: repo });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    const d1 = packetDigest(built.data.packet);
    const d2 = packetDigest(built.data.packet);
    assert.equal(d1, d2);
    assert.match(d1, /^[a-f0-9]{16}$/);
  } finally {
    cleanup();
  }
});
