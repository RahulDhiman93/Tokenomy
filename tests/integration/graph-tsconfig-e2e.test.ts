import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { buildGraph } from "../../src/graph/build.js";
import { findUsages } from "../../src/graph/query/usages.js";
import { JsonGraphStore } from "../../src/graph/store.js";
import { resolveRepoId } from "../../src/graph/repo-id.js";

// Real-world scenario: Next.js-style repo with `@/` alias. Without
// tsconfig-paths resolution (pre-alpha.17), `find_usages` on an aliased-
// imported hook returns 0 callers. With it, real callers surface.
test("e2e: find_usages surfaces aliased imports through tsconfig.paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "tokenomy-e2e-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tokenomy-e2e-repo-"));
  const prev = process.env["HOME"];
  process.env["HOME"] = home;
  try {
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    mkdirSync(join(repo, "src", "hooks"), { recursive: true });
    mkdirSync(join(repo, "src", "app"), { recursive: true });
    mkdirSync(join(repo, "src", "components"), { recursive: true });

    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@/*": ["src/*"] },
        },
      }),
    );
    writeFileSync(
      join(repo, "src", "hooks", "useCounter.ts"),
      "export const useCounter = () => 42;\n",
    );
    writeFileSync(
      join(repo, "src", "app", "page.tsx"),
      'import { useCounter } from "@/hooks/useCounter";\n' +
        "export const Page = () => useCounter();\n",
    );
    writeFileSync(
      join(repo, "src", "components", "header.tsx"),
      'import { useCounter } from "@/hooks/useCounter";\n' +
        "export const Header = () => useCounter();\n",
    );
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });

    const built = await buildGraph({ cwd: repo, config: DEFAULT_CONFIG });
    assert.equal(built.ok, true);

    const { repoId } = resolveRepoId(repo);
    const graph = new JsonGraphStore().loadGraph(repoId);
    assert.ok(graph);
    if (!graph) return;

    const result = findUsages(
      graph,
      { target: { file: "src/hooks/useCounter.ts", symbol: "useCounter" } },
      DEFAULT_CONFIG,
      false,
      [],
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const callerFiles = new Set(
      result.data.call_sites.map((s) => s.file ?? s.id).filter(Boolean),
    );
    assert.ok(
      callerFiles.has("src/app/page.tsx"),
      `expected src/app/page.tsx in callers; got ${JSON.stringify([...callerFiles])}`,
    );
    assert.ok(
      callerFiles.has("src/components/header.tsx"),
      `expected src/components/header.tsx in callers; got ${JSON.stringify([...callerFiles])}`,
    );
  } finally {
    if (prev === undefined) delete process.env["HOME"];
    else process.env["HOME"] = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});
