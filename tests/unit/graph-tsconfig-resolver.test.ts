import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { buildGraph } from "../../src/graph/build.js";
import { enumerateAllFiles } from "../../src/graph/enumerate.js";
import { fingerprintTsconfigs } from "../../src/graph/tsconfig-fingerprint.js";
import { JsonGraphStore } from "../../src/graph/store.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";
import type { Config } from "../../src/core/types.js";
import type { Graph } from "../../src/graph/schema.js";

const withSandbox = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-tsc-home-"));
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-tsc-repo-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
};

const stage = (dir: string): void => {
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
};

const loadGraph = (repo: string): Graph => {
  const { repoId } = resolveRepoId(repo);
  const graph = new JsonGraphStore().loadGraph(repoId);
  if (!graph) throw new Error("graph not built");
  return graph;
};

const hasImportsEdge = (graph: Graph, from: string, to: string): boolean =>
  graph.edges.some((e) => e.kind === "imports" && e.from === from && e.to === to);

test("tsconfig resolver: `@/*` alias resolves imports to real files", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src", "hooks"), { recursive: true });
    mkdirSync(join(repo, "src", "app"), { recursive: true });
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
      }),
    );
    writeFileSync(join(repo, "src", "hooks", "useX.ts"), "export const useX = () => 1;\n");
    writeFileSync(
      join(repo, "src", "app", "page.tsx"),
      'import { useX } from "@/hooks/useX";\nexport const Page = () => useX();\n',
    );
    stage(repo);

    const r = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(r.ok, true);

    const graph = loadGraph(repo);
    // Previously this would have been ext:@/hooks/useX (external). Now it's
    // a real imports edge from page.tsx → file:src/hooks/useX.ts.
    assert.ok(
      hasImportsEdge(graph, "file:src/app/page.tsx", "file:src/hooks/useX.ts"),
      `expected @/hooks/useX to resolve to src/hooks/useX.ts; got edges: ${JSON.stringify(
        graph.edges.filter((e) => e.from === "file:src/app/page.tsx"),
      )}`,
    );
  });
});

test("tsconfig resolver: baseUrl without paths resolves non-relative imports", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src", "util"), { recursive: true });
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "src" } }),
    );
    writeFileSync(join(repo, "src", "util", "one.ts"), "export const one = 1;\n");
    writeFileSync(
      join(repo, "src", "app.ts"),
      'import { one } from "util/one";\nexport const x = one;\n',
    );
    stage(repo);

    const r = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    assert.ok(
      hasImportsEdge(graph, "file:src/app.ts", "file:src/util/one.ts"),
      "baseUrl-only projects should resolve non-relative bare-ish imports",
    );
  });
});

test("tsconfig resolver: extends chain with local base config works", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src", "shared"), { recursive: true });
    writeFileSync(
      join(repo, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@shared/*": ["src/shared/*"] },
        },
      }),
    );
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json" }),
    );
    writeFileSync(
      join(repo, "src", "shared", "util.ts"),
      "export const util = () => 2;\n",
    );
    writeFileSync(
      join(repo, "src", "app.ts"),
      'import { util } from "@shared/util";\nexport const y = util;\n',
    );
    stage(repo);

    const r = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    assert.ok(
      hasImportsEdge(graph, "file:src/app.ts", "file:src/shared/util.ts"),
      "extends chain should carry paths from base to downstream tsconfig",
    );
  });
});

test("tsconfig resolver: monorepo nested tsconfigs — each package uses its own paths", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "packages", "a", "src"), { recursive: true });
    mkdirSync(join(repo, "packages", "b", "src"), { recursive: true });
    writeFileSync(
      join(repo, "packages", "a", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@a/*": ["src/*"] } },
      }),
    );
    writeFileSync(
      join(repo, "packages", "b", "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@b/*": ["src/*"] } },
      }),
    );
    writeFileSync(
      join(repo, "packages", "a", "src", "hook.ts"),
      "export const hookA = () => 1;\n",
    );
    writeFileSync(
      join(repo, "packages", "b", "src", "widget.ts"),
      "export const widgetB = () => 2;\n",
    );
    writeFileSync(
      join(repo, "packages", "a", "src", "app.ts"),
      'import { hookA } from "@a/hook";\nexport const aApp = hookA;\n',
    );
    writeFileSync(
      join(repo, "packages", "b", "src", "app.ts"),
      'import { widgetB } from "@b/widget";\nexport const bApp = widgetB;\n',
    );
    stage(repo);

    const r = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    assert.ok(
      hasImportsEdge(
        graph,
        "file:packages/a/src/app.ts",
        "file:packages/a/src/hook.ts",
      ),
      "package a should resolve @a/* via its own tsconfig",
    );
    assert.ok(
      hasImportsEdge(
        graph,
        "file:packages/b/src/app.ts",
        "file:packages/b/src/widget.ts",
      ),
      "package b should resolve @b/* via its own tsconfig",
    );
  });
});

test("tsconfig resolver: jsconfig.json is honored the same as tsconfig.json", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "jsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    writeFileSync(join(repo, "src", "lib.js"), "export const lib = () => 3;\n");
    writeFileSync(
      join(repo, "src", "entry.js"),
      'import { lib } from "@/lib";\nexport const e = lib;\n',
    );
    stage(repo);

    const r = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    assert.ok(
      hasImportsEdge(graph, "file:src/entry.js", "file:src/lib.js"),
      "jsconfig.json paths should resolve identically to tsconfig.json",
    );
  });
});

test("tsconfig resolver: alias target excluded from graph stays external-module", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "vendor"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@vendor/*": ["vendor/*"] } },
      }),
    );
    writeFileSync(join(repo, "vendor", "lib.ts"), "export const lib = 1;\n");
    writeFileSync(
      join(repo, "src", "app.ts"),
      'import { lib } from "@vendor/lib";\nexport const v = lib;\n',
    );
    stage(repo);

    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, exclude: ["vendor/**"] },
    };
    const r = await buildGraph({ cwd: repo, config: cfg });
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    // The alias points at an excluded file → resolver returns null → falls
    // back to external-module. No imports edge TO the excluded file should
    // exist (it isn't in the graph at all).
    assert.ok(
      !hasImportsEdge(graph, "file:src/app.ts", "file:vendor/lib.ts"),
      "excluded alias target must NOT be credited as an in-graph file edge",
    );
    // External-module node should exist for @vendor/lib specifier.
    assert.ok(
      graph.nodes.some(
        (n) => n.kind === "external-module" && n.name === "@vendor/lib",
      ),
      "alias target outside graph should become external-module",
    );
  });
});

test("tsconfig resolver: no tsconfig in repo — pre-alpha.17 behavior preserved", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "src", "app.ts"),
      'import { thing } from "@some/alias";\nexport const x = thing;\n',
    );
    stage(repo);

    const r = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    // Specifier remains external-module with no tsconfig present.
    assert.ok(
      graph.nodes.some(
        (n) => n.kind === "external-module" && n.name === "@some/alias",
      ),
      "no tsconfig → bare specifier should still become external-module",
    );
  });
});

test("tsconfig resolver: graph.tsconfig.enabled=false restores pre-alpha.17 behavior", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src", "hooks"), { recursive: true });
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    writeFileSync(join(repo, "src", "hooks", "useX.ts"), "export const useX = () => 1;\n");
    writeFileSync(
      join(repo, "src", "app.ts"),
      'import { useX } from "@/hooks/useX";\nexport const x = useX;\n',
    );
    stage(repo);

    const cfg: Config = {
      ...DEFAULT_CONFIG,
      graph: { ...DEFAULT_CONFIG.graph, tsconfig: { enabled: false } },
    };
    const r = await buildGraph({ cwd: repo, config: cfg });
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    assert.ok(
      !hasImportsEdge(graph, "file:src/app.ts", "file:src/hooks/useX.ts"),
      "disabled tsconfig resolver must not resolve alias to real file",
    );
    assert.ok(
      graph.nodes.some(
        (n) => n.kind === "external-module" && n.name === "@/hooks/useX",
      ),
      "with resolver disabled, @/hooks/useX should be external-module",
    );
  });
});

test("tsconfig resolver: malformed tsconfig fails open; other imports still work", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "tsconfig.json"), "{ this is not json");
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(
      join(repo, "src", "b.ts"),
      'import { a } from "./a";\nexport const b = a;\n',
    );
    stage(repo);

    const r = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    // Build still succeeds — malformed tsconfig doesn't tear down the graph.
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    // Relative imports resolve normally.
    assert.ok(hasImportsEdge(graph, "file:src/b.ts", "file:src/a.ts"));
  });
});

test("tsconfig resolver: auxiliary variants (tsconfig.app.json etc.) don't shadow the canonical tsconfig.json", async () => {
  // Angular / Vue / Nx repos commonly keep `tsconfig.json` (governing) next to
  // `tsconfig.app.json` / `tsconfig.build.json` (auxiliary). Sorted
  // alphabetically, the auxiliary comes first — resolver must still pick the
  // canonical one.
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src", "lib"), { recursive: true });
    writeFileSync(
      join(repo, "tsconfig.app.json"),
      JSON.stringify({ compilerOptions: { paths: { "@wrong/*": ["dist/*"] } } }),
    );
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    writeFileSync(
      join(repo, "tsconfig.spec.json"),
      JSON.stringify({ compilerOptions: { paths: { "@other/*": ["test/*"] } } }),
    );
    writeFileSync(join(repo, "src", "lib", "thing.ts"), "export const thing = 1;\n");
    writeFileSync(
      join(repo, "src", "app.ts"),
      'import { thing } from "@/lib/thing";\nexport const x = thing;\n',
    );
    stage(repo);

    const r = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(r.ok, true);
    const graph = loadGraph(repo);
    assert.ok(
      hasImportsEdge(graph, "file:src/app.ts", "file:src/lib/thing.ts"),
      "canonical tsconfig.json must govern resolution even when auxiliary variants live alongside it",
    );
  });
});

test("fingerprintTsconfigs: stable when nothing changes, shifts when paths edit", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    stage(repo);

    const raw1 = enumerateAllFiles(repo).files;
    const fp1 = fingerprintTsconfigs(repo, raw1);
    const fp1b = fingerprintTsconfigs(repo, raw1);
    assert.equal(fp1, fp1b, "fingerprint must be stable across identical inputs");

    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@lib/*": ["src/lib/*"] } },
      }),
    );
    const raw2 = enumerateAllFiles(repo).files;
    const fp2 = fingerprintTsconfigs(repo, raw2);
    assert.notEqual(fp1, fp2, "editing paths must change fingerprint");
  });
});

test("fingerprintTsconfigs: editing a base config invalidates via extends chain", async () => {
  await withSandbox(async (repo) => {
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(
      join(repo, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
    );
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json" }),
    );
    writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
    stage(repo);

    const raw1 = enumerateAllFiles(repo).files;
    const fp1 = fingerprintTsconfigs(repo, raw1);

    // Editing the BASE (not the leaf) must invalidate.
    writeFileSync(
      join(repo, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@@/*": ["src/*"] } },
      }),
    );
    const raw2 = enumerateAllFiles(repo).files;
    const fp2 = fingerprintTsconfigs(repo, raw2);
    assert.notEqual(fp1, fp2, "base-config edits must invalidate via extends chain");
  });
});
