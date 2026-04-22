import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  _setNpmSearchFetchForTests,
  npmSearch,
} from "../../src/nudge/npm-search.js";

// The fake npm binary is a tiny shell script that outputs configured JSON and
// exits with the configured status. It exercises CLI fallback branches without
// hitting the real npm binary.
interface FakeNpmSetup {
  stdout: string;
  status: number;
  sleepSeconds?: number;
}

const withFakeNpm = async <T>(
  setup: FakeNpmSetup | "missing",
  fn: () => Promise<T>,
): Promise<T> => {
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
    return await fn();
  } finally {
    if (originalPath === undefined) delete process.env["PATH"];
    else process.env["PATH"] = originalPath;
    rmSync(bin, { recursive: true, force: true });
  }
};

const withNpmRegistry = async <T>(
  body: string | null | ((url: string) => string | null),
  fn: (urls: string[]) => Promise<T>,
): Promise<T> => {
  const urls: string[] = [];
  try {
    _setNpmSearchFetchForTests(async (url) => {
      urls.push(url);
      return typeof body === "function" ? body(url) : body;
    });
    return await fn(urls);
  } finally {
    _setNpmSearchFetchForTests();
  }
};

const sampleEntries = JSON.stringify({
  objects: [
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
  ],
});

test("npmSearch: happy path returns ranked results, drops junk + deprecated", async () => {
  await withNpmRegistry(sampleEntries, async () => {
    const r = await npmSearch("retry helper", {
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
  });
});

test("npmSearch: registry HTTPS path is used before CLI fallback", async () => {
  await withNpmRegistry(sampleEntries, async (urls) => {
    await withFakeNpm({ stdout: "[]", status: 99 }, async () => {
      const r = await npmSearch("retry helper", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.results[0]!.name, "p-retry");
      assert.equal(
        urls[0],
        "https://registry.npmjs.org/-/v1/search?text=retry%20helper&size=20",
      );
      assert.ok(urls.length > 1);
    });
  });
});

test("npmSearch: falls back to CLI when registry HTTP is unavailable", async () => {
  const cliEntries = JSON.stringify([
    {
      package: {
        name: "async-retry",
        version: "1.3.3",
        description: "Retry with exponential backoff",
      },
      score: { final: 0.7, detail: { quality: 0.7, popularity: 0.7, maintenance: 0.7 } },
      searchScore: 0.8,
    },
  ]);
  await withNpmRegistry(null, async () => {
    await withFakeNpm({ stdout: cliEntries, status: 0 }, async () => {
      const r = await npmSearch("retry helper", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.deepEqual(r.results.map((entry) => entry.name), ["async-retry"]);
    });
  });
});

test("npmSearch: falls back to CLI when registry JSON is null", async () => {
  const cliEntries = JSON.stringify([
    {
      package: {
        name: "p-retry",
        version: "6.2.0",
        description: "Retry promises",
      },
      score: { final: 0.8, detail: { quality: 0.8, popularity: 0.8, maintenance: 0.8 } },
      searchScore: 0.8,
    },
  ]);
  await withNpmRegistry("null", async () => {
    await withFakeNpm({ stdout: cliEntries, status: 0 }, async () => {
      const r = await npmSearch("retry", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.deepEqual(r.results.map((entry) => entry.name), ["p-retry"]);
    });
  });
});

test("npmSearch: variant aggregation can lift canonical packages over literal text matches", async () => {
  const response = (names: string[]) =>
    JSON.stringify({
      objects: names.map((name, index) => ({
        package: {
          name,
          version: "1.0.0",
          description: `${name} retry backoff helper`,
        },
        score: {
          final: 100 - index,
          detail: { quality: 1, popularity: 1, maintenance: 1 },
        },
        searchScore: 100 - index,
      })),
    });
  const bodies = new Map([
    [
      "retry with exponential backoff",
      response(["retry-cli", "@example/retry-cli", "retry", "p-retry"]),
    ],
    [
      "retry exponential backoff",
      response(["retry", "p-retry", "async-retry", "retry-cli"]),
    ],
    [
      "async retry backoff",
      response(["p-retry", "async-retry", "retry"]),
    ],
    [
      "promise retry backoff",
      response(["p-retry", "retry", "async-retry"]),
    ],
    ["keywords:backoff", response(["p-retry", "retry"])],
    ["keywords:retry", response(["p-retry", "async-retry"])],
  ]);
  const downloads = new Map([
    ["retry-cli", 100],
    ["@example/retry-cli", 100],
    ["retry", 1_000_000],
    ["p-retry", 750_000],
    ["async-retry", 500_000],
  ]);

  await withNpmRegistry((url) => {
    if (url.startsWith("https://api.npmjs.org/downloads/point/last-week/")) {
      const name = decodeURIComponent(url.split("/").pop() ?? "");
      return JSON.stringify({ downloads: downloads.get(name) ?? 0 });
    }
    const text = new URL(url).searchParams.get("text") ?? "";
    return bodies.get(text) ?? JSON.stringify({ objects: [] });
  }, async () => {
    const r = await npmSearch("retry with exponential backoff", {
      timeoutMs: 5000,
      minWeeklyDownloads: 0,
      maxResults: 3,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.results.map((entry) => entry.name), [
      "p-retry",
      "retry",
      "async-retry",
    ]);
    assert.ok(r.results.every((entry) => entry.score.overall >= 0.7));
  });
});

test("npmSearch: download enrichment uses remaining registry deadline", async () => {
  const body = JSON.stringify({
    objects: [
      {
        package: { name: "p-retry", version: "1.0.0", description: "retry" },
        score: { final: 1, detail: { quality: 1, popularity: 1, maintenance: 1 } },
        searchScore: 1,
      },
    ],
  });
  await withNpmRegistry((url) => {
    if (url.startsWith("https://api.npmjs.org/downloads/point/last-week/")) {
      return JSON.stringify({ downloads: 1000 });
    }
    return body;
  }, async (urls) => {
    const originalDateNow = Date.now;
    const times = [1_000, 1_006, 1_010, 1_012, 1_014, 1_016, 1_021, 1_022, 1_023];
    Date.now = () => times.shift() ?? 1_023;
    try {
      const r = await npmSearch("retry", {
        timeoutMs: 20,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, true);
      assert.ok(urls.some((url) => url.includes("/-/v1/search")));
      assert.ok(!urls.some((url) => url.includes("/downloads/point/last-week/")));
    } finally {
      Date.now = originalDateNow;
    }
  });
});

test("npmSearch: normalizes raw registry relevance scores into 0-1 overall scores", async () => {
  const entries = JSON.stringify({
    objects: [
      {
        package: { name: "retry-cli", version: "1.0.0", description: "retry cli" },
        score: { final: 100, detail: { quality: 1, popularity: 1, maintenance: 1 } },
        searchScore: 100,
      },
      {
        package: { name: "p-retry", version: "6.2.0", description: "Retry promises" },
        score: { final: 75, detail: { quality: 1, popularity: 1, maintenance: 1 } },
        searchScore: 75,
      },
    ],
  });
  await withNpmRegistry(entries, async () => {
    const r = await npmSearch("retry", {
      timeoutMs: 5000,
      minWeeklyDownloads: 0,
      maxResults: 5,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.results[0]!.score.overall, 1);
    assert.ok(r.results.every((entry) => entry.score.overall <= 1));
  });
});

test("npmSearch: registry package object without score is accepted", async () => {
  const packageOnly = JSON.stringify({
    objects: [
      {
        name: "p-retry",
        version: "6.2.0",
        description: "Retry a promise-returning or async function",
        date: "2024-11-01T00:00:00.000Z",
        links: { npm: "https://www.npmjs.com/package/p-retry" },
      },
    ],
  });
  await withNpmRegistry(packageOnly, async () => {
    const r = await npmSearch("retry", {
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

test("npmSearch: maxResults caps the returned list", async () => {
  await withNpmRegistry(sampleEntries, async () => {
    const r = await npmSearch("retry", {
      timeoutMs: 5000,
      minWeeklyDownloads: 0,
      maxResults: 1,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0]!.name, "p-retry");
  });
});

test("npmSearch: minWeeklyDownloads filters low-popularity candidates", async () => {
  const entries = JSON.stringify({
    objects: [
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
    ],
  });
  await withNpmRegistry(entries, async () => {
    const r = await npmSearch("retry", {
      timeoutMs: 5000,
      minWeeklyDownloads: 1000,
      maxResults: 5,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.results.map((entry) => entry.name), ["popular"]);
  });
});

test("npmSearch: empty search result returns ok with zero results", async () => {
  await withNpmRegistry(JSON.stringify({ objects: [] }), async () => {
    const r = await npmSearch("asdf-no-such-package-xyz", {
      timeoutMs: 5000,
      minWeeklyDownloads: 0,
      maxResults: 5,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.results.length, 0);
  });
});

test("npmSearch: malformed CLI fallback JSON fails open with bad-json reason", async () => {
  await withNpmRegistry(null, async () => {
    await withFakeNpm({ stdout: "this is not json{{{", status: 0 }, async () => {
      const r = await npmSearch("x", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, "bad-json");
    });
  });
});

test("npmSearch: non-zero CLI fallback exit fails open with npm-failed reason", async () => {
  await withNpmRegistry(null, async () => {
    await withFakeNpm({ stdout: "[]", status: 1 }, async () => {
      const r = await npmSearch("x", {
        timeoutMs: 5000,
        minWeeklyDownloads: 0,
        maxResults: 5,
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, "npm-failed");
    });
  });
});

test("npmSearch: npm binary not found returns npm-unavailable with install hint", async () => {
  await withNpmRegistry(null, async () => {
    await withFakeNpm("missing", async () => {
      const r = await npmSearch("x", {
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
});

test("npmSearch: empty query rejected up-front as invalid-input", async () => {
  // No need for a fake npm — short-circuits before spawn.
  const r = await npmSearch("   ", {
    timeoutMs: 5000,
    minWeeklyDownloads: 0,
    maxResults: 5,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "invalid-input");
});

test("npmSearch: ranking prefers higher searchScore × final, not insertion order", async () => {
  // Flip: put the worse candidate first; ranker should re-order.
  const flipped = JSON.stringify({
    objects: [
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
    ],
  });
  await withNpmRegistry(flipped, async () => {
    const r = await npmSearch("x", {
      timeoutMs: 5000,
      minWeeklyDownloads: 0,
      maxResults: 5,
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.results[0]!.name, "better");
  });
});
