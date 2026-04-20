import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PROFILES,
  applyProfile,
  selectProfile,
  type TrimProfile,
} from "../../src/rules/profiles.js";

test("selectProfile: picks most specific match", () => {
  const profiles: TrimProfile[] = [
    { name: "generic", match: "mcp__*", keep: ["id"] },
    { name: "atlassian", match: "mcp__*Atlassian*__*", keep: ["id"] },
    { name: "jira-issue", match: "mcp__*Atlassian*__getJiraIssue", keep: ["id"] },
  ];
  const p = selectProfile("mcp__claude_ai_Atlassian__getJiraIssue", profiles);
  assert.equal(p?.name, "jira-issue");
});

test("selectProfile: no match returns null", () => {
  const p = selectProfile("Read", BUILTIN_PROFILES);
  assert.equal(p, null);
});

test("selectProfile: case-insensitive matching (Codex lowercase names)", () => {
  const p = selectProfile(
    "mcp__codex_apps__atlassian_rovo__getjiraissue",
    BUILTIN_PROFILES,
  );
  assert.equal(p?.name, "atlassian-jira-issue");
});

test("selectProfile: Codex GitHub fetch_pr / search_prs hit github-pr-codex", () => {
  for (const name of [
    "mcp__codex_apps__github__fetch_pr",
    "mcp__codex_apps__github__get_pr_info",
    "mcp__codex_apps__github__search_prs",
  ]) {
    const p = selectProfile(name, BUILTIN_PROFILES);
    assert.equal(p?.name, "github-pr-codex", `expected match for ${name}`);
  }
});

test("applyProfile: keeps top-level dotted keys, drops others", () => {
  const profile: TrimProfile = {
    name: "t",
    match: "mcp__*",
    keep: ["key", "fields.summary", "fields.status.name"],
  };
  const payload = {
    key: "PROJ-1",
    self: "https://atlassian.net/..." /* should be dropped */,
    fields: {
      summary: "Bug in thing",
      description: "a".repeat(5_000) /* dropped */,
      status: { name: "In Progress", id: "10001" /* id dropped */ },
      assignee: { displayName: "X" /* dropped */ },
    },
  };
  const r = applyProfile(JSON.stringify(payload), profile);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!.replace(/\n\[tokenomy:[^\]]+\]$/, ""));
  assert.equal(parsed.key, "PROJ-1");
  assert.equal(parsed.self, undefined);
  assert.equal(parsed.fields.summary, "Bug in thing");
  assert.equal(parsed.fields.description, undefined);
  assert.equal(parsed.fields.status.name, "In Progress");
  assert.equal(parsed.fields.status.id, undefined);
  assert.equal(parsed.fields.assignee, undefined);
});

test("applyProfile: array wildcard selects per-item keys", () => {
  const profile: TrimProfile = {
    name: "t",
    match: "mcp__*",
    keep: ["issues.*.key", "issues.*.fields.summary"],
  };
  const payload = {
    total: 2,
    issues: [
      { key: "A-1", fields: { summary: "one", description: "x".repeat(1000) } },
      { key: "A-2", fields: { summary: "two", description: "y".repeat(1000) } },
    ],
  };
  const r = applyProfile(JSON.stringify(payload), profile);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!.replace(/\n\[tokenomy:[^\]]+\]$/, ""));
  assert.equal(parsed.issues.length, 2);
  assert.equal(parsed.issues[0].key, "A-1");
  assert.equal(parsed.issues[0].fields.description, undefined);
  assert.equal(parsed.total, undefined);
});

test("applyProfile: max_string_bytes trims long strings", () => {
  const profile: TrimProfile = {
    name: "t",
    match: "mcp__*",
    keep: ["body"],
    max_string_bytes: 100,
  };
  const payload = { body: "z".repeat(5_000) };
  const r = applyProfile(JSON.stringify(payload), profile);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!.replace(/\n\[tokenomy:[^\]]+\]$/, ""));
  assert.ok(parsed.body.length < 5_000);
  assert.match(parsed.body, /tokenomy: elided/);
});

test("applyProfile: max_array_items drops overflow with marker", () => {
  const profile: TrimProfile = {
    name: "t",
    match: "mcp__*",
    keep: ["items"],
    max_array_items: 3,
  };
  // Make items big enough that truncation produces real savings.
  const payload = {
    items: Array.from({ length: 7 }, (_, i) => `item-${i}-${"x".repeat(100)}`),
  };
  const r = applyProfile(JSON.stringify(payload), profile);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!.replace(/\n\[tokenomy:[^\]]+\]$/, ""));
  assert.equal(parsed.items.length, 4); // 3 + 1 marker
  assert.match(String(parsed.items[3]), /elided 4 items/);
});

test("applyProfile: returns ok:false for non-JSON text", () => {
  const profile: TrimProfile = { name: "t", match: "mcp__*", keep: ["x"] };
  const r = applyProfile("This is plain text, not JSON.", profile);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not-json");
});

test("applyProfile: returns ok:false when nothing matches", () => {
  const profile: TrimProfile = { name: "t", match: "mcp__*", keep: ["nonexistent.key"] };
  const r = applyProfile(JSON.stringify({ other: 1 }), profile);
  assert.equal(r.ok, false);
});

test("applyProfile: no-savings returns ok:false", () => {
  const profile: TrimProfile = { name: "t", match: "mcp__*", keep: ["a", "b", "c"] };
  const r = applyProfile(JSON.stringify({ a: 1, b: 2, c: 3 }), profile);
  // Pretty-printed JSON + footer is likely larger than the compact input.
  assert.equal(r.ok, false);
});

test("builtin atlassian-jira-transitions: keeps all rows, trims bodies", () => {
  // Mirror a realistic getTransitionsForJiraIssue response: ~15 transitions,
  // each row ~400 B of JSON. Raw ~6 KB. Expectation: all rows kept, names
  // and IDs preserved, bulk fields (fields array, expand wrapper) dropped.
  const payload = {
    expand: "transitions",
    transitions: Array.from({ length: 15 }, (_, i) => ({
      id: String(i + 1),
      name: `Transition-${i + 1}`,
      hasScreen: false,
      isGlobal: true,
      isInitial: i === 0,
      isAvailable: true,
      isConditional: false,
      to: {
        id: `1000${i}`,
        name: `State-${i + 1}`,
        description: "x".repeat(300),
        iconUrl: "https://example.atlassian.net/icon",
        statusCategory: {
          id: 4,
          key: i % 2 === 0 ? "indeterminate" : "done",
          name: "In Progress",
          colorName: "yellow",
          self: "https://example.atlassian.net/rest/api/3/statuscategory/4",
        },
      },
    })),
  };
  const profile = selectProfile(
    "mcp__claude_ai_Atlassian__getTransitionsForJiraIssue",
    BUILTIN_PROFILES,
  );
  assert.equal(profile?.name, "atlassian-jira-transitions");
  const r = applyProfile(JSON.stringify(payload), profile!);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!.replace(/\n\[tokenomy:[^\]]+\]$/, ""));
  assert.equal(parsed.transitions.length, 15);
  assert.equal(parsed.transitions[0].id, "1");
  assert.equal(parsed.transitions[0].name, "Transition-1");
  assert.equal(parsed.transitions[0].to.statusCategory.key, "indeterminate");
  // Bulk per-row fields dropped
  assert.equal(parsed.transitions[0].hasScreen, undefined);
  assert.equal(parsed.transitions[0].to.description, undefined);
  assert.ok(
    r.bytesOut < r.bytesIn / 2,
    `expected >50% reduction, got ${r.bytesIn} → ${r.bytesOut}`,
  );
});

test("builtin atlassian-jira-projects: keeps all rows", () => {
  const payload = {
    self: "https://example.atlassian.net/rest/api/3/project/search",
    maxResults: 50,
    startAt: 0,
    total: 3,
    isLast: true,
    values: [
      { id: "10000", key: "LX", name: "LiveX", projectTypeKey: "software", description: "x".repeat(500), lead: { displayName: "A" }, avatarUrls: { "16x16": "a", "24x24": "b" } },
      { id: "10001", key: "ENG", name: "Engineering", projectTypeKey: "software", description: "y".repeat(500), lead: {}, avatarUrls: {} },
      { id: "10002", key: "OPS", name: "Operations", projectTypeKey: "business", description: "z".repeat(500), lead: {}, avatarUrls: {} },
    ],
  };
  const profile = selectProfile(
    "mcp__claude_ai_Atlassian__getVisibleJiraProjects",
    BUILTIN_PROFILES,
  );
  assert.equal(profile?.name, "atlassian-jira-projects");
  const r = applyProfile(JSON.stringify(payload), profile!);
  assert.equal(r.ok, true);
  const parsed = JSON.parse(r.trimmed!.replace(/\n\[tokenomy:[^\]]+\]$/, ""));
  assert.equal(parsed.values.length, 3);
  assert.equal(parsed.values[0].key, "LX");
  assert.equal(parsed.values[0].description, undefined);
  assert.equal(parsed.values[0].avatarUrls, undefined);
});

test("builtin atlassian-jira-issue profile reduces a realistic payload", () => {
  const big = {
    key: "PROJ-42",
    id: "10042",
    self: "https://example.atlassian.net/rest/api/3/issue/10042",
    fields: {
      summary: "Login fails under load",
      status: { name: "In Progress", id: "10001" },
      assignee: { displayName: "Alice", emailAddress: "a@x" },
      description: "a".repeat(10_000),
      comment: { comments: Array(50).fill({ body: "x".repeat(500) }) },
      history: Array(100).fill({ created: "2026-01-01", items: [] }),
    },
  };
  const profile = selectProfile("mcp__claude_ai_Atlassian__getJiraIssue", BUILTIN_PROFILES);
  assert.ok(profile);
  const r = applyProfile(JSON.stringify(big), profile!);
  assert.equal(r.ok, true);
  assert.ok(r.bytesOut < r.bytesIn / 2, `expected >50% reduction, got ${r.bytesIn} → ${r.bytesOut}`);
  assert.match(r.trimmed!, /PROJ-42/);
  assert.match(r.trimmed!, /In Progress/);
});
