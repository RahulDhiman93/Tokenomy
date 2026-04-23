import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusLine } from "../../src/cli/statusline.js";

test("renderStatusLine: active with no savings", () => {
  assert.equal(renderStatusLine({ active: true, tokensToday: 0 }), "[Tokenomy: active]");
});

test("renderStatusLine: savings and graph state", () => {
  assert.equal(
    renderStatusLine({ active: true, tokensToday: 4200, graph: "fresh" }),
    "[Tokenomy: 4.2k saved · graph fresh]",
  );
  assert.equal(
    renderStatusLine({ active: true, tokensToday: 4200, graph: "stale" }),
    "[Tokenomy: 4.2k saved · graph stale - rebuild]",
  );
});

test("renderStatusLine: golem mode takes priority", () => {
  assert.equal(
    renderStatusLine({ active: true, tokensToday: 4200, golem: "full" }),
    "[Tokenomy: GOLEM-FULL · 4.2k saved]",
  );
});

