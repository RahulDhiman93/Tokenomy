import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { npmSearch } from "../../src/nudge/npm-search.js";

// Controls the fake npm binary's behavior via env vars. The fake is a tiny
// shell script that outputs whatever NPM_FAKE_STDOUT says and exits with
// NPM_FAKE_STATUS. Lets us exercise every branch of npmSearch without
// hitting the real npm or the network.
interface FakeNpmSetup {
  stdout: string;
  status: number;
  sleepSeconds?: number;
}

const withFakeNpm = <T>(setup: FakeNpmSetup | "missing", fn: () => T): T => {
  const bin = mkdtempSync(join(tmpdir(), "tokenomy-fake-npm-"));
  const originalPath = process.env["PATH"];
  try {
    if (setup === "missing") {
      // Empty PATH (plus /usr/bin/env for shebangs if needed) so `npm` is
      // not resolvable → spawnSync returns ENOENT.
      process.env["PATH"] = bin;
    } else {
      const npmScript = `#!/bin/sh\n${setup.sleepSeconds ? `sleep ${setup.sleepSeconds}\n` : ""}cat <<'JSON'\n${setup.stdout}\nJSON\nexit ${setup.status}\n`;
      const npmPath = join(bin, "npm");
      writeFileSync(npmPath, npmScript);
      chmodSync(npmPath, 0o755);
      process.env["PATH"] = `${bin}${delimiter}${originalPath ?? ""}`;
    }
    return fn();
  } finally {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    rmSync(bin, { recursive: true, force: true });
  }
};

const sampleEntries = JSON.stringify([
  {
    package: {
      name: "p-retry",
      version: "6.2.0",
      description: "Retry a promise-returning or async function",
      date: "2024-11-01T00:00:00.000Z",
      links: { npm: "https://www.npmjs.com/package/p-retry" },
    },
    score: { final: 0.8, detail: { quality: 0.9, popularity: 0.75, maintenance: 0.82 } },
    searchScore: 0.9,
  },
  {
    package: {
      name: "async-retry",
      version: "1.3.3",
      description: "Retry with exponential backoff",
    },
    score: { final: 0.6, detail: { quality: 0.7, popularity: 0.55, maintenance: 0.6 } },
    searchScore: 0.55,
  },
  {
    package: {
      name: "junk-pkg",
      version: "0.0.1",
      description: "barely maintained",
    },
    score: { final: 0.1, detail: { quality: 0.1, popularity: 0.05, maintenance: 0.1 } },
    searchScore: 0.3,
  },
  {
    package: {
      name: "deprecated-retry",
      version: "1.0.0",
      description: "old retry util",
    },
    score: { final: 0.65, detail: { quality: 0.6, popularity: 0.6, maintenance: 0.7 } },
    searchScore: 0.4,
    deprecated: "Use p-retry instead",
  },
]);

test("npmSearch: happy path returns ranked results, drops junk + deprecated", () => {
  withFakeNpm(
    { stdout: sampleEntries, status: 0 },
    () => {
      const r = npmSearch("retry helper", {
        timeoutMs: 5000,
        minWeeklyDownloads: 1000,
        maxResults: 5,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      const names = r.results.map((x) => x.name);
      assert.deepEqual(names, ["p-retry", "async-retry"]);
      // Fit reason includes maintenance language.
      assert.match(r.results[0]!.fit_reason, /maintained|adoption|quality/);
    },
  );
});

test("npmSearch: standard package-only npm JSON is accepted", () => {
  const packageOnly = JSON.stringify([
    {
      name: "p-retry",
      version: "6.2.0",
      description: "Retry a promise-returning or async function",
      date: "2024-11-01T00:00:00.000Z",
      links: { npm: "https://www.npmjs.com/package/p-retry" },
    },
  ]);
  withFakeNpm({ stdout: packageOnly, status: 0 }, () => {
    const r = npmSearch("retry", {
      timeoutMs: 5000,
      minWeeklyDownloads: 1000,
      maxResults: 5,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0]!.name, "p-retry");
  });
});

test("npmSearch: maxResults caps the returned list", () => {
  withFakeNpm(
    { stdout: sampleEntries, status: 0 },
    () => {
      const r = npmSearch("retry", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 1,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.results.length, 1);
      assert.equal(r.results[0]!.name, "p-retry");
    },
  );
});

test("npmSearch: minWeeklyDownloads filters low-popularity candidates", () => {
  const entries = JSON.stringify([
    {
      package: { name: "popular", version: "1.0.0", description: "popular retry" },
      score: { final: 0.9, detail: { quality: 0.9, popularity: 0.72, maintenance: 0.9 } },
      searchScore: 0.9,
    },
    {
      package: { name: "niche", version: "1.0.0", description: "niche retry" },
      score: { final: 0.9, detail: { quality: 0.9, popularity: 0.2, maintenance: 0.9 } },
      searchScore: 0.95,
    },
  ]);
  withFakeNpm({ stdout: entries, status: 0 }, () => {
    const r = npmSearch("retry", {
      timeoutMs: 5000,
      minWeeklyDownloads: 1000,
      maxResults: 5,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.results.map((entry) => entry.name), ["popular"]);
  });
});

test("npmSearch: empty search result returns ok with zero results", () => {
  withFakeNpm(
    { stdout: "[]", status: 0 },
    () => {
      const r = npmSearch("asdf-no-such-package-xyz", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.results.length, 0);
    },
  );
});

test("npmSearch: malformed JSON fails open with bad-json reason", () => {
  withFakeNpm(
    { stdout: "this is not json{{{", status: 0 },
    () => {
      const r = npmSearch("x", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, "bad-json");
    },
  );
});

test("npmSearch: non-zero exit fails open with npm-failed reason", () => {
  withFakeNpm(
    { stdout: "[]", status: 1 },
    () => {
      const r = npmSearch("x", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, "npm-failed");
    },
  );
});

test("npmSearch: npm binary not found returns npm-unavailable with install hint", () => {
  withFakeNpm("missing", () => {
    const r = npmSearch("x", {
      timeoutMs: 5000,
      minWeeklyDownloads: 0,
      maxResults: 5,
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "npm-unavailable");
    assert.ok(r.hint && r.hint.includes("npm"));
  });
});

test("npmSearch: empty query rejected up-front as invalid-input", () => {
  // No need for a fake npm — short-circuits before spawn.
  const r = npmSearch("   ", {
    timeoutMs: 5000,
    minWeeklyDownloads: 0,
    maxResults: 5,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "invalid-input");
});

test("npmSearch: ranking prefers higher searchScore × final, not insertion order", () => {
  // Flip: put the worse candidate first; ranker should re-order.
  const flipped = JSON.stringify([
    {
      package: { name: "lesser", version: "1.0.0", description: "less good" },
      score: { final: 0.4, detail: { quality: 0.4, popularity: 0.4, maintenance: 0.4 } },
      searchScore: 0.3,
    },
    {
      package: { name: "better", version: "1.0.0", description: "much better" },
      score: { final: 0.9, detail: { quality: 0.9, popularity: 0.9, maintenance: 0.9 } },
      searchScore: 0.9,
    },
  ]);
  withFakeNpm({ stdout: flipped, status: 0 }, () => {
    const r = npmSearch("x", {
      timeoutMs: 5000,
      minWeeklyDownloads: 0,
      maxResults: 5,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.results[0]!.name, "better");
  });
});
