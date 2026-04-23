import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveGolemMode, type GolemTuneState } from "../../src/rules/golem.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { golemTunePath } from "../../src/core/paths.js";

const setupHome = () => {
  const dir = join(tmpdir(), `tokenomy-tune-${process.pid}-${Date.now()}`);
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

test("resolveGolemMode: concrete mode passes through", () => {
  const cfg = { ...DEFAULT_CONFIG, golem: { ...DEFAULT_CONFIG.golem, mode: "ultra" as const } };
  assert.equal(resolveGolemMode(cfg), "ultra");
});

test("resolveGolemMode: auto falls back to full when no tune file exists", () => {
  const h = setupHome();
  try {
    const cfg = { ...DEFAULT_CONFIG, golem: { ...DEFAULT_CONFIG.golem, mode: "auto" as const } };
    assert.equal(resolveGolemMode(cfg), "full");
  } finally {
    h.restore();
  }
});

test("resolveGolemMode: auto reads concrete mode from tune file", () => {
  const h = setupHome();
  try {
    const tune: GolemTuneState = {
      mode: "grunt",
      confidence: "high",
      window_sessions: 25,
      last_updated_ts: new Date().toISOString(),
      reasoning: "test",
    };
    mkdirSync(join(h.home, ".tokenomy"), { recursive: true });
    writeFileSync(golemTunePath(), JSON.stringify(tune), "utf8");
    const cfg = { ...DEFAULT_CONFIG, golem: { ...DEFAULT_CONFIG.golem, mode: "auto" as const } };
    assert.equal(resolveGolemMode(cfg), "grunt");
  } finally {
    h.restore();
  }
});

test("resolveGolemMode: malformed tune file falls back to full", () => {
  const h = setupHome();
  try {
    mkdirSync(join(h.home, ".tokenomy"), { recursive: true });
    writeFileSync(golemTunePath(), "not json", "utf8");
    const cfg = { ...DEFAULT_CONFIG, golem: { ...DEFAULT_CONFIG.golem, mode: "auto" as const } };
    assert.equal(resolveGolemMode(cfg), "full");
  } finally {
    h.restore();
  }
});

test("computeGolemTune: empty roots → mode=lite, low confidence", async () => {
  const h = setupHome();
  try {
    const { computeGolemTune } = await import("../../src/analyze/tune.js");
    const r = computeGolemTune({});
    assert.equal(r.sessionCount, 0);
    assert.equal(r.state.mode, "lite");
    assert.equal(r.state.confidence, "low");
  } finally {
    h.restore();
  }
});

test("writeGolemTune: round-trips through filesystem", async () => {
  const h = setupHome();
  try {
    const { writeGolemTune } = await import("../../src/analyze/tune.js");
    const state: GolemTuneState = {
      mode: "ultra",
      confidence: "medium",
      window_sessions: 10,
      last_updated_ts: new Date().toISOString(),
      reasoning: "synthetic test",
    };
    const path = writeGolemTune(state);
    assert.ok(existsSync(path));
    const back = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(back.mode, "ultra");
    assert.equal(back.confidence, "medium");
  } finally {
    h.restore();
  }
});
