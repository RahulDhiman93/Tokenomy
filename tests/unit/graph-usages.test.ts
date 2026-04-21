import { test } from "node:test";
import assert from "node:assert/strict";
import { findUsages } from "../../src/graph/query/usages.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import type { Graph } from "../../src/graph/schema.js";

const graph: Graph = {
  schema_version: 1,
  repo_id: "test",
  nodes: [
    { id: "file:src/a.ts", kind: "file", name: "src/a.ts", file: "src/a.ts" },
    { id: "file:src/b.ts", kind: "file", name: "src/b.ts", file: "src/b.ts" },
    { id: "file:src/c.ts", kind: "file", name: "src/c.ts", file: "src/c.ts" },
    {
      id: "sym:src/a.ts#foo@1:0",
      kind: "function",
      name: "foo",
      file: "src/a.ts",
      range: { start: 0, end: 10, line: 1 },
    },
    {
      id: "sym:src/b.ts#callFoo@2:0",
      kind: "function",
      name: "callFoo",
      file: "src/b.ts",
      range: { start: 0, end: 10, line: 2 },
    },
  ],
  edges: [
    { from: "file:src/b.ts", to: "file:src/a.ts", kind: "imports", confidence: "definite" },
    { from: "file:src/c.ts", to: "file:src/a.ts", kind: "imports", confidence: "definite" },
    {
      from: "sym:src/b.ts#callFoo@2:0",
      to: "sym:src/a.ts#foo@1:0",
      kind: "calls",
      confidence: "definite",
    },
  ],
  parse_errors: [],
};

test("find_usages: returns direct importers for a file target", () => {
  const r = findUsages(
    graph,
    { target: { file: "src/a.ts" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id).sort();
  assert.ok(ids.includes("file:src/b.ts"));
  assert.ok(ids.includes("file:src/c.ts"));
});

test("find_usages: returns callers for a symbol target", () => {
  const r = findUsages(
    graph,
    { target: { file: "src/a.ts", symbol: "foo" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id);
  assert.ok(ids.includes("sym:src/b.ts#callFoo@2:0"));
  assert.equal(r.data.focal.name, "foo");
});

test("find_usages: unknown target fails open", () => {
  const r = findUsages(
    graph,
    { target: { file: "src/does-not-exist.ts" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, "target-not-found");
});

test("find_usages: summary reports usage count", () => {
  const r = findUsages(
    graph,
    { target: { file: "src/a.ts" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.data.summary, /\d+ usage/);
});

// Mirrors the shape the TS extractor actually emits for a cross-module call:
// - `imports` edges land on the *file* node, not the exported symbol.
// - `calls` edges from caller functions land on the local `imported-symbol` node
//   in the importer file, not on the definition in the exporting file.
// `find_usages` must walk through imported-symbol nodes to surface real callers.
const crossModuleGraph: Graph = {
  schema_version: 1,
  repo_id: "test",
  nodes: [
    { id: "file:src/hook.ts", kind: "file", name: "src/hook.ts", file: "src/hook.ts" },
    { id: "file:src/caller.ts", kind: "file", name: "src/caller.ts", file: "src/caller.ts" },
    {
      id: "sym:src/hook.ts#useCfg@1:0",
      kind: "function",
      name: "useCfg",
      file: "src/hook.ts",
      range: { start: 0, end: 10, line: 1 },
      exported: true,
    },
    {
      id: "sym:src/caller.ts#Component@5:0",
      kind: "function",
      name: "Component",
      file: "src/caller.ts",
      range: { start: 0, end: 50, line: 5 },
    },
    // Imported-symbol node in the caller file, bound to the local name.
    // Extractor writes `original_name: "useCfg"` to confirm this came from a
    // named import (vs. a default/namespace that just happens to collide).
    {
      id: "imp:src/caller.ts#useCfg@2:0",
      kind: "imported-symbol",
      name: "useCfg",
      original_name: "useCfg",
      file: "src/caller.ts",
    },
  ],
  edges: [
    { from: "file:src/caller.ts", to: "file:src/hook.ts", kind: "imports", confidence: "definite" },
    { from: "imp:src/caller.ts#useCfg@2:0", to: "file:src/hook.ts", kind: "imports", confidence: "definite" },
    // The real extractor emits `calls` to the local imported-symbol, NOT to the definition.
    { from: "sym:src/caller.ts#Component@5:0", to: "imp:src/caller.ts#useCfg@2:0", kind: "calls", confidence: "inferred" },
  ],
  parse_errors: [],
};

test("find_usages: symbol target surfaces cross-module callers via imported-symbol traversal", () => {
  const r = findUsages(
    crossModuleGraph,
    { target: { file: "src/hook.ts", symbol: "useCfg" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id);
  // Caller function found via the new two-hop traversal.
  assert.ok(
    ids.includes("sym:src/caller.ts#Component@5:0"),
    `expected Component to be surfaced as a call site; got ${JSON.stringify(ids)}`,
  );
  // File-level importer also surfaced (useful context for widely-used hooks).
  assert.ok(ids.includes("file:src/caller.ts"));
});

// Aliased named imports (`import { useCfg as useLocal }`) produce an
// imported-symbol node with `name = "useLocal"` (local binding) and
// `original_name = "useCfg"` (the export name in the source module). The
// query matches on `original_name ?? name`, so aliased callers ARE surfaced.
const aliasedGraph: Graph = {
  schema_version: 1,
  repo_id: "test",
  nodes: [
    { id: "file:src/hook.ts", kind: "file", name: "src/hook.ts", file: "src/hook.ts" },
    { id: "file:src/caller.ts", kind: "file", name: "src/caller.ts", file: "src/caller.ts" },
    {
      id: "sym:src/hook.ts#useCfg@1:0",
      kind: "function",
      name: "useCfg",
      file: "src/hook.ts",
      range: { start: 0, end: 10, line: 1 },
      exported: true,
    },
    {
      id: "sym:src/caller.ts#Component@5:0",
      kind: "function",
      name: "Component",
      file: "src/caller.ts",
      range: { start: 0, end: 50, line: 5 },
    },
    // Imported-symbol node is named `useLocal` (the alias) with
    // `original_name: "useCfg"` tracking the source export.
    {
      id: "imp:src/caller.ts#useLocal@2:0",
      kind: "imported-symbol",
      name: "useLocal",
      original_name: "useCfg",
      file: "src/caller.ts",
    },
  ],
  edges: [
    { from: "file:src/caller.ts", to: "file:src/hook.ts", kind: "imports", confidence: "definite" },
    { from: "imp:src/caller.ts#useLocal@2:0", to: "file:src/hook.ts", kind: "imports", confidence: "definite" },
    { from: "sym:src/caller.ts#Component@5:0", to: "imp:src/caller.ts#useLocal@2:0", kind: "calls", confidence: "inferred" },
  ],
  parse_errors: [],
};

test("find_usages: aliased imports are traced via original_name tracking", () => {
  const r = findUsages(
    aliasedGraph,
    { target: { file: "src/hook.ts", symbol: "useCfg" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id);
  // File-level importer surfaced.
  assert.ok(ids.includes("file:src/caller.ts"));
  // Caller function now surfaced via original_name matching on the imp node.
  assert.ok(
    ids.includes("sym:src/caller.ts#Component@5:0"),
    `Component should be credited to useCfg via its original_name on the imp node; got ${JSON.stringify(ids)}`,
  );
});

// Regression guard for the codex round-1 false-positive scenario:
// mod.ts exports BOTH foo and bar. caller.ts does `import { bar as foo }`,
// so its imp node has name="foo" and original_name="bar". A query for `foo`
// in mod.ts must NOT credit caller's call (it's really using bar).
const collidingAliasGraph: Graph = {
  schema_version: 1,
  repo_id: "test",
  nodes: [
    { id: "file:src/mod.ts", kind: "file", name: "src/mod.ts", file: "src/mod.ts" },
    { id: "file:src/caller.ts", kind: "file", name: "src/caller.ts", file: "src/caller.ts" },
    {
      id: "sym:src/mod.ts#foo@1:0",
      kind: "function",
      name: "foo",
      file: "src/mod.ts",
      range: { start: 0, end: 10, line: 1 },
      exported: true,
    },
    {
      id: "sym:src/mod.ts#bar@2:0",
      kind: "function",
      name: "bar",
      file: "src/mod.ts",
      range: { start: 0, end: 10, line: 2 },
      exported: true,
    },
    {
      id: "sym:src/caller.ts#caller@3:0",
      kind: "function",
      name: "caller",
      file: "src/caller.ts",
      range: { start: 0, end: 20, line: 3 },
    },
    // imp has local name "foo" but original is "bar".
    {
      id: "imp:src/caller.ts#foo@1:0",
      kind: "imported-symbol",
      name: "foo",
      original_name: "bar",
      file: "src/caller.ts",
    },
  ],
  edges: [
    { from: "file:src/caller.ts", to: "file:src/mod.ts", kind: "imports", confidence: "definite" },
    { from: "imp:src/caller.ts#foo@1:0", to: "file:src/mod.ts", kind: "imports", confidence: "definite" },
    { from: "sym:src/caller.ts#caller@3:0", to: "imp:src/caller.ts#foo@1:0", kind: "calls", confidence: "inferred" },
  ],
  parse_errors: [],
};

test("find_usages: aliased name collision does NOT false-positive", () => {
  const r = findUsages(
    collidingAliasGraph,
    { target: { file: "src/mod.ts", symbol: "foo" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id);
  // File-level importer is legitimate — caller.ts does import from mod.ts.
  assert.ok(ids.includes("file:src/caller.ts"));
  // Caller function must NOT be credited to `foo` — it actually calls `bar`.
  assert.ok(
    !ids.includes("sym:src/caller.ts#caller@3:0"),
    `caller calls bar (aliased as foo), not foo — crediting it to foo would be a false positive. Got ${JSON.stringify(ids)}`,
  );
});

test("find_usages: unaliased named imports match via original_name=name", () => {
  // New extractor sets original_name === local name for unaliased named
  // imports (no propertyName). This disambiguates them from default/namespace
  // imports where the local binding may incidentally collide with a named
  // export's name.
  const plainGraph: Graph = {
    schema_version: 1,
    repo_id: "test",
    nodes: [
      { id: "file:src/m.ts", kind: "file", name: "src/m.ts", file: "src/m.ts" },
      { id: "file:src/c.ts", kind: "file", name: "src/c.ts", file: "src/c.ts" },
      {
        id: "sym:src/m.ts#hello@1:0",
        kind: "function",
        name: "hello",
        file: "src/m.ts",
        range: { start: 0, end: 10, line: 1 },
        exported: true,
      },
      {
        id: "sym:src/c.ts#main@2:0",
        kind: "function",
        name: "main",
        file: "src/c.ts",
        range: { start: 0, end: 20, line: 2 },
      },
      {
        id: "imp:src/c.ts#hello@1:0",
        kind: "imported-symbol",
        name: "hello",
        original_name: "hello",
        file: "src/c.ts",
      },
    ],
    edges: [
      { from: "file:src/c.ts", to: "file:src/m.ts", kind: "imports", confidence: "definite" },
      { from: "imp:src/c.ts#hello@1:0", to: "file:src/m.ts", kind: "imports", confidence: "definite" },
      { from: "sym:src/c.ts#main@2:0", to: "imp:src/c.ts#hello@1:0", kind: "calls", confidence: "inferred" },
    ],
    parse_errors: [],
  };
  const r = findUsages(
    plainGraph,
    { target: { file: "src/m.ts", symbol: "hello" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id);
  assert.ok(ids.includes("sym:src/c.ts#main@2:0"));
});

// Regression guard for codex round-2 review: a default import whose local
// binding happens to match a named export in the source module must NOT be
// credited to that named export. The extractor signals "this is a default
// import" by OMITTING original_name; the query skips such nodes in the
// cross-module pass.
const defaultImportCollisionGraph: Graph = {
  schema_version: 1,
  repo_id: "test",
  nodes: [
    { id: "file:src/m.ts", kind: "file", name: "src/m.ts", file: "src/m.ts" },
    { id: "file:src/c.ts", kind: "file", name: "src/c.ts", file: "src/c.ts" },
    {
      id: "sym:src/m.ts#foo@1:0",
      kind: "function",
      name: "foo",
      file: "src/m.ts",
      range: { start: 0, end: 10, line: 1 },
      exported: true,
    },
    {
      id: "sym:src/c.ts#main@2:0",
      kind: "function",
      name: "main",
      file: "src/c.ts",
      range: { start: 0, end: 20, line: 2 },
    },
    // Default import: local name happens to be "foo", but no original_name.
    // This represents `import foo from './m'` where the default export is
    // a differently-named function.
    { id: "imp:src/c.ts#foo@1:0", kind: "imported-symbol", name: "foo", file: "src/c.ts" },
  ],
  edges: [
    { from: "file:src/c.ts", to: "file:src/m.ts", kind: "imports", confidence: "definite" },
    { from: "imp:src/c.ts#foo@1:0", to: "file:src/m.ts", kind: "imports", confidence: "definite" },
    { from: "sym:src/c.ts#main@2:0", to: "imp:src/c.ts#foo@1:0", kind: "calls", confidence: "inferred" },
  ],
  parse_errors: [],
};

// Regression guard for codex round-5 review: when the importing file calls
// the symbol at TOP level, the extractor emits the caller as the file node
// itself (no enclosing function). The cross-module traversal must record
// the call BEFORE the file-level-import placeholder so the caller isn't
// deduped behind the import placeholder.
const topLevelCallGraph: Graph = {
  schema_version: 1,
  repo_id: "test",
  nodes: [
    { id: "file:src/mod.ts", kind: "file", name: "src/mod.ts", file: "src/mod.ts" },
    { id: "file:src/caller.ts", kind: "file", name: "src/caller.ts", file: "src/caller.ts" },
    {
      id: "sym:src/mod.ts#run@1:0",
      kind: "function",
      name: "run",
      file: "src/mod.ts",
      range: { start: 0, end: 10, line: 1 },
      exported: true,
    },
    {
      id: "imp:src/caller.ts#run@1:0",
      kind: "imported-symbol",
      name: "run",
      original_name: "run",
      file: "src/caller.ts",
    },
  ],
  edges: [
    { from: "file:src/caller.ts", to: "file:src/mod.ts", kind: "imports", confidence: "definite" },
    { from: "imp:src/caller.ts#run@1:0", to: "file:src/mod.ts", kind: "imports", confidence: "definite" },
    // Top-level call: caller is the file node itself.
    { from: "file:src/caller.ts", to: "imp:src/caller.ts#run@1:0", kind: "calls", confidence: "inferred" },
  ],
  parse_errors: [],
};

test("find_usages: top-level call is preserved even when file also appears as a file-level importer", () => {
  const r = findUsages(
    topLevelCallGraph,
    { target: { file: "src/mod.ts", symbol: "run" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const callerEntry = r.data.call_sites.find((c) => c.id === "file:src/caller.ts");
  assert.ok(callerEntry, "file:src/caller.ts must appear as a call site");
  // The call edge must win over the import placeholder.
  assert.equal(
    callerEntry.edge_kind,
    "calls",
    `expected edge_kind=calls for top-level caller; got ${callerEntry.edge_kind}`,
  );
});

// Regression guard for codex round-5 review: method / local-function queries
// where the focal's local name happens to match an exported name in the same
// file must NOT get cross-module callers credited. Only exported focals can
// receive cross-module usages by definition.
const nonExportedFocalGraph: Graph = {
  schema_version: 1,
  repo_id: "test",
  nodes: [
    { id: "file:src/mixed.ts", kind: "file", name: "src/mixed.ts", file: "src/mixed.ts" },
    { id: "file:src/caller.ts", kind: "file", name: "src/caller.ts", file: "src/caller.ts" },
    // A private method named `foo` on class C — not exported.
    {
      id: "sym:src/mixed.ts#C.foo@1:0",
      kind: "method",
      name: "foo",
      file: "src/mixed.ts",
      range: { start: 0, end: 10, line: 1 },
    },
    // A separate exported function also named `foo` in the same file.
    {
      id: "sym:src/mixed.ts#foo@5:0",
      kind: "function",
      name: "foo",
      file: "src/mixed.ts",
      range: { start: 0, end: 10, line: 5 },
      exported: true,
    },
    {
      id: "sym:src/caller.ts#use@1:0",
      kind: "function",
      name: "use",
      file: "src/caller.ts",
      range: { start: 0, end: 20, line: 1 },
    },
    {
      id: "imp:src/caller.ts#foo@1:0",
      kind: "imported-symbol",
      name: "foo",
      original_name: "foo",
      file: "src/caller.ts",
    },
  ],
  edges: [
    { from: "file:src/caller.ts", to: "file:src/mixed.ts", kind: "imports", confidence: "definite" },
    { from: "imp:src/caller.ts#foo@1:0", to: "file:src/mixed.ts", kind: "imports", confidence: "definite" },
    { from: "sym:src/caller.ts#use@1:0", to: "imp:src/caller.ts#foo@1:0", kind: "calls", confidence: "inferred" },
  ],
  parse_errors: [],
};

test("find_usages: non-exported focal does not attract cross-module callers of a same-named export", () => {
  const r = findUsages(
    nonExportedFocalGraph,
    // Query resolves to the method (first match in resolveTargetNode) — not exported.
    { target: { file: "src/mixed.ts", symbol: "foo" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id);
  // The caller imports and calls the EXPORTED foo (function), not the method.
  // Since the resolver picks the method first AND the method isn't exported,
  // the cross-module traversal must skip and return no cross-module callers.
  assert.ok(
    !ids.includes("sym:src/caller.ts#use@1:0"),
    `method focal must not be credited with callers of a same-named export. Got ${JSON.stringify(ids)}`,
  );
});

test("find_usages: default/namespace import collision with named export does NOT false-positive", () => {
  const r = findUsages(
    defaultImportCollisionGraph,
    { target: { file: "src/m.ts", symbol: "foo" } },
    DEFAULT_CONFIG,
    false,
    [],
  );
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const ids = r.data.call_sites.map((c) => c.id);
  // File-level importer is legitimate.
  assert.ok(ids.includes("file:src/c.ts"));
  // main() calls the DEFAULT export, not the named export foo. Must not match.
  assert.ok(
    !ids.includes("sym:src/c.ts#main@2:0"),
    `Default-import caller must not be credited to a same-named named export. Got ${JSON.stringify(ids)}`,
  );
});
