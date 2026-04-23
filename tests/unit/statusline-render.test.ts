import { test } from "node:test";
import assert from "node:assert/strict";
import { renderStatusLine } from "../../src/cli/statusline.js";
import { TOKENOMY_VERSION } from "../../src/core/version.js";

const V = `v${TOKENOMY_VERSION}`;

test("renderStatusLine: active with no savings", () => {
  assert.equal(renderStatusLine({ active: true, tokensToday: 0 }), `[Tokenomy ${V} · active]`);
});

test("renderStatusLine: savings and graph state", () => {
  assert.equal(
    renderStatusLine({ active: true, tokensToday: 4200, graph: "fresh" }),
    `[Tokenomy ${V} · 4.2k saved · graph fresh]`,
  );
  assert.equal(
    renderStatusLine({ active: true, tokensToday: 4200, graph: "stale" }),
    `[Tokenomy ${V} · 4.2k saved · graph stale - rebuild]`,
  );
});

test("renderStatusLine: golem mode takes priority", () => {
  assert.equal(
    renderStatusLine({ active: true, tokensToday: 4200, golem: "full" }),
    `[Tokenomy ${V} · GOLEM-FULL · 4.2k saved]`,
  );
});

test("renderStatusLine: inactive returns empty string", () => {
  assert.equal(renderStatusLine({ active: false, tokensToday: 0 }), "");
});

test("renderStatusLine: golem without savings hides saved segment", () => {
  assert.equal(
    renderStatusLine({ active: true, tokensToday: 0, golem: "grunt" }),
    `[Tokenomy ${V} · GOLEM-GRUNT]`,
  );
});

test("renderStatusLine: Raven marker appears when enabled", () => {
  assert.equal(
    renderStatusLine({ active: true, tokensToday: 0, raven: true }),
    `[Tokenomy ${V} · active · Raven]`,
  );
});
