import { test } from "node:test";
import assert from "node:assert/strict";
import { configForTool, resolveToolOverride, DEFAULT_CONFIG } from "../../src/core/config.js";
import type { Config } from "../../src/core/types.js";

const cfg = (tools: Config["tools"]): Config =>
  ({ ...DEFAULT_CONFIG, tools } as Config);

test("resolveToolOverride: exact glob matches", () => {
  const ov = resolveToolOverride(
    cfg({ "mcp__Atlassian__*": { aggression: "aggressive" } }),
    "mcp__Atlassian__getJiraIssue",
  );
  assert.equal(ov?.aggression, "aggressive");
});

test("resolveToolOverride: most specific wins", () => {
  const ov = resolveToolOverride(
    cfg({
      "mcp__*": { aggression: "conservative" },
      "mcp__Atlassian__*": { aggression: "balanced" },
      "mcp__Atlassian__getJiraIssue": { aggression: "aggressive" },
    }),
    "mcp__Atlassian__getJiraIssue",
  );
  assert.equal(ov?.aggression, "aggressive");
});

test("resolveToolOverride: returns undefined when no match", () => {
  const ov = resolveToolOverride(cfg({ "Read": { disable_redact: true } }), "Bash");
  assert.equal(ov, undefined);
});

test("configForTool: aggression override adjusts thresholds", () => {
  const base = cfg({ "mcp__Atlassian__*": { aggression: "aggressive" } });
  // Ensure base config is balanced / conservative — not aggressive.
  const forAtlassian = configForTool({ ...base, aggression: "conservative" }, "mcp__Atlassian__getJiraIssue");
  const forOther = configForTool({ ...base, aggression: "conservative" }, "mcp__Slack__x");
  // Aggressive max_text_bytes should be < conservative.
  assert.ok(forAtlassian.mcp.max_text_bytes < forOther.mcp.max_text_bytes);
});

test("configForTool: falls back to base config when override has no aggression", () => {
  const base = cfg({ "mcp__*": { disable_redact: true } });
  const effective = configForTool(base, "mcp__x__y");
  // No aggression change → same thresholds.
  assert.equal(effective.mcp.max_text_bytes, base.mcp.max_text_bytes);
});

test("configForTool: disable_redact is surfaced via resolveToolOverride", () => {
  const base = cfg({ "Bash": { disable_redact: true } });
  const ov = resolveToolOverride(base, "Bash");
  assert.equal(ov?.disable_redact, true);
});
