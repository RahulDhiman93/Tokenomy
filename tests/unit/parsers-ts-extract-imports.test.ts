import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTypescript } from "../../src/parsers/ts/loader.js";
import { extractTsFileGraph } from "../../src/parsers/ts/extract.js";

test("parsers ts extract: named/default/namespace imports and re-exports become graph edges", async () => {
  const tsLoaded = await loadTypescript(process.cwd());
  assert.equal(tsLoaded.ok, true);
  if (!tsLoaded.ok) return;

  const source = `
import thing, { foo as localFoo } from "./foo";
import * as ns from "./bar";
export { localFoo as renamed } from "./foo";
export * from "./bar";
export default thing;
`;
  const result = extractTsFileGraph(
    "src/example.ts",
    source,
    new Set(["src/foo.ts", "src/bar.ts"]),
    tsLoaded.ts,
  );

  const nodeIds = result.nodes.map((node) => node.id);
  assert.ok(nodeIds.includes("file:src/example.ts"));
  assert.ok(nodeIds.some((id) => id.startsWith("imp:src/example.ts#thing@")));
  assert.ok(nodeIds.some((id) => id.startsWith("imp:src/example.ts#localFoo@")));
  assert.ok(nodeIds.some((id) => id.startsWith("imp:src/example.ts#ns@")));
  assert.ok(nodeIds.includes("exp:src/example.ts#renamed"));
  assert.ok(nodeIds.includes("exp:src/example.ts#default"));

  const importTargets = result.edges
    .filter((edge) => edge.kind === "imports")
    .map((edge) => edge.to)
    .sort();
  assert.deepEqual(importTargets, [
    "file:src/bar.ts",
    "file:src/bar.ts",
    "file:src/foo.ts",
    "file:src/foo.ts",
    "file:src/foo.ts",
  ]);

  const exportTargets = result.edges
    .filter((edge) => edge.kind === "exports")
    .map((edge) => `${edge.to}:${edge.confidence}`)
    .sort();
  assert.deepEqual(exportTargets, [
    "file:src/bar.ts:inferred",
    "file:src/foo.ts:definite",
    "imp:src/example.ts#thing@2:0:definite",
  ]);
});

test("parsers ts extract: require and dynamic import are inferred imports", async () => {
  const tsLoaded = await loadTypescript(process.cwd());
  assert.equal(tsLoaded.ok, true);
  if (!tsLoaded.ok) return;

  const source = `
const dep = require("./dep");
export async function loadDep() {
  return import("./lazy");
}
`;
  const result = extractTsFileGraph(
    "src/example.ts",
    source,
    new Set(["src/dep.js", "src/lazy.ts"]),
    tsLoaded.ts,
  );

  const inferredImports = result.edges.filter((edge) => edge.kind === "imports");
  assert.deepEqual(
    inferredImports.map((edge) => `${edge.to}:${edge.confidence}`).sort(),
    [
      "file:src/dep.js:inferred",
      "file:src/dep.js:inferred",
      "file:src/lazy.ts:inferred",
    ],
  );
  assert.ok(result.nodes.some((node) => node.id.startsWith("imp:src/example.ts#dep@")));
});
