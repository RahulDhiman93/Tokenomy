import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addHook,
  countHooksForPath,
  hasOverlappingMcpHook,
  removeHookByCommandPath,
} from "../../src/util/settings-patch.js";

const HOOK = "/Users/me/.tokenomy/bin/tokenomy-hook";

test("addHook: creates hooks.PostToolUse when absent", () => {
  const out = addHook({ model: "opus" }, "PostToolUse", HOOK, "mcp__.*", 10);
  assert.equal(countHooksForPath(out, HOOK), 1);
  assert.equal((out as { model: string }).model, "opus");
});

test("addHook: supports PreToolUse event", () => {
  let s = addHook({}, "PostToolUse", HOOK, "mcp__.*", 10);
  s = addHook(s, "PreToolUse", HOOK, "Read", 10);
  assert.equal(countHooksForPath(s, HOOK, "PostToolUse"), 1);
  assert.equal(countHooksForPath(s, HOOK, "PreToolUse"), 1);
  assert.equal(countHooksForPath(s, HOOK), 2);
});

test("removeHookByCommandPath: removes quoted + unquoted entries, keeps others", () => {
  const s = {
    model: "opus",
    hooks: {
      PostToolUse: [
        {
          matcher: "mcp__.*",
          hooks: [
            { type: "command", command: `"${HOOK}"`, timeout: 10 },
            { type: "command", command: "/other/hook", timeout: 5 },
          ],
        },
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "/bash/hook" }],
        },
      ],
    },
  };
  const cleaned = removeHookByCommandPath(s, HOOK);
  assert.equal(countHooksForPath(cleaned, HOOK), 0);
  // The /other/hook and /bash/hook entries survive
  const pt = cleaned.hooks!.PostToolUse!;
  assert.equal(pt.length, 2);
});

test("removeHookByCommandPath: collapses empty matcher groups", () => {
  const s = {
    hooks: {
      PostToolUse: [
        { matcher: "mcp__.*", hooks: [{ type: "command", command: `"${HOOK}"` }] },
      ],
    },
  };
  const cleaned = removeHookByCommandPath(s, HOOK);
  assert.equal(cleaned.hooks, undefined);
});

test("hasOverlappingMcpHook: detects third-party mcp__ hook", () => {
  const s = {
    hooks: {
      PostToolUse: [
        { matcher: "mcp__.*", hooks: [{ command: `"${HOOK}"` }] },
        { matcher: "mcp__other", hooks: [{ command: "/other/hook" }] },
      ],
    },
  };
  assert.equal(hasOverlappingMcpHook(s, HOOK), true);
});

test("idempotent: init-then-init keeps exactly one entry per event", () => {
  let s: ReturnType<typeof addHook> = {};
  s = removeHookByCommandPath(s, HOOK);
  s = addHook(s, "PostToolUse", HOOK, "mcp__.*", 10);
  s = addHook(s, "PreToolUse", HOOK, "Read", 10);
  s = removeHookByCommandPath(s, HOOK);
  s = addHook(s, "PostToolUse", HOOK, "mcp__.*", 10);
  s = addHook(s, "PreToolUse", HOOK, "Read", 10);
  assert.equal(countHooksForPath(s, HOOK, "PostToolUse"), 1);
  assert.equal(countHooksForPath(s, HOOK, "PreToolUse"), 1);
});
