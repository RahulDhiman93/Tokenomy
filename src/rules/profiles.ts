import { utf8Bytes } from "./text-trim.js";

// A trim profile turns a structured JSON payload (inside an MCP text block)
// into a compact summary by keeping "essential" fields and eliding everything
// else. The goal is qualitative: preserve the keys a downstream agent actually
// reads (ids, titles, status, assignees) and drop long free-form bodies.
//
// Matching is wildcard-glob against the MCP tool name ("mcp__Atlassian__*").
// Priority: the longer, more-specific pattern wins. Ties resolve by
// definition order, with user profiles taking precedence over built-ins.
//
// Profiles are advisory: if the JSON cannot be parsed or no matching profile
// exists, the caller falls back to the default head+tail byte trim.

export interface TrimProfile {
  name: string;
  match: string; // glob: "mcp__Atlassian__*"
  keep: string[]; // dot paths. "*" wildcard allowed as a segment.
  // Max length for string values that survive the keep filter. Longer strings
  // get head+tail trimmed down. 0 or unset = no per-field trim.
  max_string_bytes?: number;
  // Max items to keep in any surviving array. Excess is dropped with a marker.
  max_array_items?: number;
}

export const BUILTIN_PROFILES: TrimProfile[] = [
  {
    name: "atlassian-jira-issue",
    match: "mcp__*Atlassian*__getJiraIssue",
    keep: [
      "key",
      "id",
      "self",
      "fields.summary",
      "fields.status.name",
      "fields.assignee.displayName",
      "fields.assignee.emailAddress",
      "fields.reporter.displayName",
      "fields.priority.name",
      "fields.issuetype.name",
      "fields.project.key",
      "fields.project.name",
      "fields.created",
      "fields.updated",
      "fields.labels",
      "fields.components.*.name",
      "fields.fixVersions.*.name",
      "fields.description",
    ],
    max_string_bytes: 800,
    max_array_items: 10,
  },
  {
    name: "atlassian-jira-search",
    match: "mcp__*Atlassian*__searchJiraIssues*",
    keep: [
      "total",
      "startAt",
      "maxResults",
      "issues.*.key",
      "issues.*.fields.summary",
      "issues.*.fields.status.name",
      "issues.*.fields.assignee.displayName",
      "issues.*.fields.priority.name",
    ],
    max_string_bytes: 400,
    max_array_items: 20,
  },
  {
    name: "atlassian-confluence-page",
    match: "mcp__*Atlassian*__getConfluencePage",
    keep: [
      "id",
      "title",
      "status",
      "spaceId",
      "authorId",
      "version.number",
      "version.createdAt",
      "parentId",
      "_links.webui",
      "body.storage.value",
      "body.atlas_doc_format.value",
    ],
    max_string_bytes: 2_000,
  },
  {
    name: "linear-issue",
    match: "mcp__*Linear*__*",
    keep: [
      "id",
      "identifier",
      "title",
      "state.name",
      "assignee.name",
      "assignee.email",
      "priority",
      "createdAt",
      "updatedAt",
      "labels.*.name",
      "team.key",
      "team.name",
      "description",
    ],
    max_string_bytes: 1_000,
    max_array_items: 10,
  },
  {
    name: "slack-channel-history",
    match: "mcp__*Slack*__slack_read_*",
    keep: [
      "messages.*.user",
      "messages.*.ts",
      "messages.*.type",
      "messages.*.text",
      "messages.*.thread_ts",
      "channel.id",
      "channel.name",
      "has_more",
    ],
    max_string_bytes: 800,
    max_array_items: 30,
  },
  {
    name: "gmail-thread",
    match: "mcp__*Gmail*__get_thread",
    keep: [
      "id",
      "historyId",
      "messages.*.id",
      "messages.*.snippet",
      "messages.*.payload.headers.*.name",
      "messages.*.payload.headers.*.value",
      "messages.*.labelIds",
    ],
    max_string_bytes: 600,
    max_array_items: 15,
  },
  {
    name: "github-pr",
    match: "mcp__*github*__*pull_request*",
    keep: [
      "number",
      "title",
      "state",
      "user.login",
      "head.ref",
      "base.ref",
      "mergeable",
      "draft",
      "body",
      "html_url",
      "labels.*.name",
    ],
    max_string_bytes: 1_500,
    max_array_items: 20,
  },
];

// Glob compile: case-insensitive so profile patterns written in
// CamelCase (e.g. `mcp__*Atlassian*__getJiraIssue`, the Claude Code style)
// also match lowercase-normalized Codex tool names like
// `mcp__codex_apps__atlassian_rovo__getjiraissue`. This keeps a single set
// of built-in profiles useful across both agents.
const globToRegex = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
};

export const selectProfile = (
  toolName: string,
  profiles: TrimProfile[],
): TrimProfile | null => {
  // Most specific (longest pattern without wildcards) wins.
  const scored = profiles
    .filter((p) => globToRegex(p.match).test(toolName))
    .map((p) => ({ p, score: p.match.replace(/\*/g, "").length }));
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.p;
};

const keyMatches = (patternSeg: string, actual: string): boolean =>
  patternSeg === "*" || patternSeg === actual;

const pathMatchesAny = (
  path: string[],
  patterns: string[][],
): { match: boolean; prefix: boolean } => {
  // match: this path is explicitly listed to keep.
  // prefix: this path is an ancestor of something listed to keep (so recurse).
  let match = false;
  let prefix = false;
  for (const pat of patterns) {
    if (pat.length === path.length) {
      let all = true;
      for (let i = 0; i < pat.length; i++) {
        if (!keyMatches(pat[i]!, path[i]!)) {
          all = false;
          break;
        }
      }
      if (all) match = true;
    }
    if (pat.length > path.length) {
      let all = true;
      for (let i = 0; i < path.length; i++) {
        if (!keyMatches(pat[i]!, path[i]!)) {
          all = false;
          break;
        }
      }
      if (all) prefix = true;
    }
  }
  return { match, prefix };
};

const trimString = (s: string, maxBytes: number): string => {
  if (maxBytes <= 0) return s;
  const bytes = utf8Bytes(s);
  if (bytes <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  const head = Math.floor(maxBytes * 0.6);
  const tail = Math.max(0, maxBytes - head - 32);
  const headStr = buf.subarray(0, head).toString("utf8");
  const tailStr = buf.subarray(Math.max(head, buf.length - tail)).toString("utf8");
  return `${headStr}…[tokenomy: elided ${bytes - head - tail} bytes]…${tailStr}`;
};

const applyProfileToValue = (
  value: unknown,
  path: string[],
  patterns: string[][],
  profile: TrimProfile,
): unknown => {
  const { match, prefix } = pathMatchesAny(path, patterns);

  if (match && !prefix) {
    // Explicit keep; apply per-field trims.
    if (typeof value === "string" && profile.max_string_bytes) {
      return trimString(value, profile.max_string_bytes);
    }
    if (Array.isArray(value) && profile.max_array_items && value.length > profile.max_array_items) {
      const kept = value.slice(0, profile.max_array_items);
      return [...kept, `[tokenomy: elided ${value.length - profile.max_array_items} items]`];
    }
    return value;
  }

  if (prefix) {
    if (Array.isArray(value)) {
      const limit = profile.max_array_items ?? value.length;
      const truncated = value.slice(0, limit);
      const mapped = truncated.map((item) =>
        applyProfileToValue(item, [...path, "*"], patterns, profile),
      );
      if (value.length > limit) {
        mapped.push(`[tokenomy: elided ${value.length - limit} items]`);
      }
      return mapped.filter((v) => v !== SENTINEL_DROP);
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const sub = applyProfileToValue(v, [...path, k], patterns, profile);
        if (sub !== SENTINEL_DROP) out[k] = sub;
      }
      return out;
    }
  }

  return SENTINEL_DROP;
};

const SENTINEL_DROP = Symbol("drop");

export interface ProfileApplyResult {
  ok: boolean;
  trimmed?: string; // new text to substitute for the original block
  bytesIn: number;
  bytesOut: number;
  reason: string;
}

// Try to apply a profile to a text block whose content is JSON. If the text
// is not JSON, or the filter would leave nothing useful, return ok:false.
export const applyProfile = (
  text: string,
  profile: TrimProfile,
): ProfileApplyResult => {
  const bytesIn = utf8Bytes(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, bytesIn, bytesOut: bytesIn, reason: "not-json" };
  }
  const patterns = profile.keep.map((k) => k.split("."));
  const filtered = applyProfileToValue(parsed, [], patterns, profile);
  if (filtered === SENTINEL_DROP) {
    return { ok: false, bytesIn, bytesOut: bytesIn, reason: "no-matches" };
  }
  const serialized = JSON.stringify(filtered, null, 2);
  const footer = `\n[tokenomy: trimmed via profile "${profile.name}"]`;
  const out = serialized + footer;
  const bytesOut = utf8Bytes(out);
  if (bytesOut >= bytesIn) {
    return { ok: false, bytesIn, bytesOut, reason: "no-savings" };
  }
  return { ok: true, trimmed: out, bytesIn, bytesOut, reason: `profile:${profile.name}` };
};
