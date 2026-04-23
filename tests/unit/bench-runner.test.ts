import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBenchMarkdown, runBench } from "../../src/bench/runner.js";

test("runBench returns deterministic scenario results", () => {
  const run = runBench("compress-agent-memory");
  assert.equal(run.results.length, 1);
  assert.equal(run.results[0]!.scenario, "compress-agent-memory");
  assert.ok(run.results[0]!.tokens_saved > 0);
});

test("renderBenchMarkdown emits a markdown table", () => {
  const md = renderBenchMarkdown(runBench("golem-output-mode"));
  assert.ok(md.includes("| Scenario | Tokens In | Tokens Out | Saved |"));
  assert.ok(md.includes("golem-output-mode"));
});

