// Transcript parser: turns raw Claude Code / Codex JSONL events into a
// normalized stream of ToolCall records that the simulator + report builder
// can consume without caring about agent-specific shape quirks.
//
// Claude Code shape:
//   { type: "assistant", message: { content: [ { type: "tool_use", id, name, input }, ... ] }, sessionId, timestamp, cwd }
//   { type: "user",      message: { content: [ { type: "tool_result", tool_use_id, content, is_error }, ... ] } }
//
// Codex CLI shape (rollout jsonl): similar but wrapped under a "payload"
// envelope with "msg"/"item_type". We probe both and emit the same
// normalized record shape either way.

export interface RawToolUse {
  session_id: string;
  project_hint: string;
  ts: string;
  tool_use_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface RawToolResult {
  session_id: string;
  ts: string;
  tool_use_id: string;
  content: unknown; // string | array[{type,text,...}]
  is_error?: boolean;
}

export interface ToolCall {
  agent: "claude-code" | "codex" | "unknown";
  session_id: string;
  project_hint: string;
  ts: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown; // same shape as HookInput.tool_response
  is_error: boolean;
  response_bytes: number;
}

const asObject = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const utf8Bytes = (s: string): number => Buffer.byteLength(s, "utf8");

// Codex CLI wraps every function_call_output in a decorated header like:
//   "Chunk ID: abc\nWall time: 0.4s\nProcess exited with code 0\n" +
//   "Original token count: 123\nOutput:\n<actual payload>"
// For MCP connector calls, <actual payload> is structured JSON (same shape
// mcpContentRule expects). For exec_command / write_stdin it's plain text
// and must NOT be JSON-parsed, even if the output happens to be valid JSON
// (e.g. `cat package.json`) — that'd mask the text as a structured object
// and downstream tooling would miscount / mis-trim it.
const CODEX_OUTPUT_PREFIX = /^(?:Chunk ID:.*\n)?(?:Wall time:.*\n)?(?:Process exited with code.*\n)?(?:Original token count:.*\n)?Output:\n/;
export const unwrapCodexOutput = (raw: unknown, toolName: string): unknown => {
  if (typeof raw !== "string") return raw;
  const match = raw.match(CODEX_OUTPUT_PREFIX);
  const stripped = match ? raw.slice(match[0].length) : raw;
  // Only MCP connector outputs get JSON-decoded. exec_command and similar
  // shell tools stay as strings so the simulator/rules see the real text.
  if (!toolName.startsWith("mcp__")) return stripped;
  const trimmed = stripped.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Fall through to string.
    }
  }
  return stripped;
};

// Per-session bookkeeping carried across lines in a single file.
// Claude Code and Codex both emit call + output as separate lines keyed by
// a correlation id — we buffer the call until its matching output arrives.
//
// session_id and project_hint start as path-derived fallbacks but get
// replaced by values read from event metadata (Claude Code: `.sessionId` +
// `.cwd`; Codex: `session_meta.payload.{id,cwd}`). This ensures sidechain
// transcripts and flat Codex rollouts still aggregate under the correct
// logical session/project rather than under a path-derived surrogate like
// the day number in `~/.codex/sessions/YYYY/MM/DD/`.
export interface ParserState {
  session_id: string;
  project_hint: string;
  // Claude Code: tool_use_id → use; Codex: call_id → use.
  pending: Map<string, RawToolUse>;
}

export const makeState = (session_id: string, project_hint: string): ParserState => ({
  session_id,
  project_hint,
  pending: new Map(),
});

// Update session/project identity from in-event metadata. Called on every
// line before extraction; once we've seen a trustworthy value we keep it.
const upgradeIdentity = (line: Record<string, unknown>, state: ParserState): void => {
  // Claude Code: assistant/user/attachment events carry `.sessionId` + `.cwd`.
  const claudeSession = typeof line["sessionId"] === "string" ? (line["sessionId"] as string) : "";
  const claudeCwd = typeof line["cwd"] === "string" ? (line["cwd"] as string) : "";
  if (claudeSession) state.session_id = claudeSession;
  if (claudeCwd) state.project_hint = claudeCwd;

  // Codex: first line is `session_meta` with `payload.{id,cwd}`.
  if (line["type"] === "session_meta") {
    const payload = asObject(line["payload"]);
    const codexId = typeof payload["id"] === "string" ? (payload["id"] as string) : "";
    const codexCwd = typeof payload["cwd"] === "string" ? (payload["cwd"] as string) : "";
    if (codexId) state.session_id = codexId;
    if (codexCwd) state.project_hint = codexCwd;
  }
};

const extractClaudeToolUses = (line: Record<string, unknown>, state: ParserState): void => {
  if (line["type"] !== "assistant") return;
  const message = asObject(line["message"]);
  const content = message["content"];
  if (!Array.isArray(content)) return;
  const ts = typeof line["timestamp"] === "string" ? (line["timestamp"] as string) : "";
  for (const block of content) {
    const b = asObject(block);
    if (b["type"] !== "tool_use") continue;
    const id = typeof b["id"] === "string" ? (b["id"] as string) : "";
    const name = typeof b["name"] === "string" ? (b["name"] as string) : "";
    if (!id || !name) continue;
    const input = asObject(b["input"]);
    state.pending.set(id, {
      session_id: state.session_id,
      project_hint: state.project_hint,
      ts,
      tool_use_id: id,
      tool_name: name,
      tool_input: input,
    });
  }
};

const extractClaudeToolResults = (
  line: Record<string, unknown>,
  state: ParserState,
  emit: (call: ToolCall) => void,
): void => {
  if (line["type"] !== "user") return;
  const message = asObject(line["message"]);
  const content = message["content"];
  if (!Array.isArray(content)) return;
  const ts = typeof line["timestamp"] === "string" ? (line["timestamp"] as string) : "";
  for (const block of content) {
    const b = asObject(block);
    if (b["type"] !== "tool_result") continue;
    const id = typeof b["tool_use_id"] === "string" ? (b["tool_use_id"] as string) : "";
    if (!id) continue;
    const use = state.pending.get(id);
    if (!use) continue; // orphan tool_result — drop
    state.pending.delete(id);

    const response = b["content"];
    const is_error = b["is_error"] === true;
    const bytes = utf8Bytes(JSON.stringify(response ?? null));
    emit({
      agent: "claude-code",
      session_id: state.session_id,
      project_hint: state.project_hint,
      ts: ts || use.ts,
      tool_name: use.tool_name,
      tool_input: use.tool_input,
      tool_response: response,
      is_error,
      response_bytes: bytes,
    });
  }
};

// Codex rollout shape (as of codex-cli 0.12x):
//   { "type":"response_item", "timestamp":"...", "payload":{
//       "type":"function_call", "name":"...", "arguments":"<json-string>",
//       "call_id":"call_..." } }
//   { "type":"response_item", "timestamp":"...", "payload":{
//       "type":"function_call_output", "call_id":"call_...", "output":"..." } }
// The call and output arrive on separate lines, keyed by call_id.
const extractCodex = (
  line: Record<string, unknown>,
  state: ParserState,
  emit: (call: ToolCall) => void,
): boolean => {
  if (line["type"] !== "response_item") return false;
  const payload = asObject(line["payload"]);
  const pType = payload["type"];
  const ts = typeof line["timestamp"] === "string" ? (line["timestamp"] as string) : "";

  if (pType === "function_call" || pType === "custom_tool_call") {
    const id = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : "";
    const rawName = typeof payload["name"] === "string" ? (payload["name"] as string) : "";
    // Codex connector tools split their identity across `namespace` +
    // `name` (e.g. namespace="mcp__codex_apps__github", name="_search_prs").
    // Normalize to the Claude-style `mcp__<vendor>__<method>` separator so
    // built-in profile globs (like `mcp__*Atlassian*__getJiraIssue`) match
    // both agents' tool names without per-agent special-casing.
    const ns = typeof payload["namespace"] === "string" ? (payload["namespace"] as string) : "";
    const name = ns
      ? rawName.startsWith("_")
        ? `${ns}_${rawName}` // name already starts with "_" → yields `__`
        : `${ns}__${rawName}` // otherwise add the full `__` separator
      : rawName;
    if (!id || !name) return true; // consumed but unusable
    // Codex serializes arguments as a JSON string; parse it opportunistically.
    let input: Record<string, unknown> = {};
    const rawArgs = payload["arguments"];
    if (typeof rawArgs === "string") {
      try {
        const parsed = JSON.parse(rawArgs);
        input = asObject(parsed);
      } catch {
        input = { _raw: rawArgs };
      }
    } else {
      input = asObject(rawArgs);
    }
    state.pending.set(id, {
      session_id: state.session_id,
      project_hint: state.project_hint,
      ts,
      tool_use_id: id,
      tool_name: name,
      tool_input: input,
    });
    return true;
  }

  if (pType === "function_call_output" || pType === "custom_tool_call_output") {
    const id = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : "";
    if (!id) return true;
    const use = state.pending.get(id);
    if (!use) return true; // orphan output — drop
    state.pending.delete(id);
    const rawOutput = payload["output"];
    const output = unwrapCodexOutput(rawOutput, use.tool_name);
    // Count observed bytes from the un-decorated raw string when the tool
    // output is plain text (shell), so we don't inflate the size by
    // re-escaping. For JSON-parsed connector outputs, stringify to get a
    // stable structured-size measurement.
    const bytes =
      typeof output === "string"
        ? utf8Bytes(output)
        : utf8Bytes(JSON.stringify(output ?? null));
    emit({
      agent: "codex",
      session_id: state.session_id,
      project_hint: state.project_hint,
      ts: ts || use.ts,
      tool_name: use.tool_name,
      tool_input: use.tool_input,
      tool_response: output,
      is_error: false,
      response_bytes: bytes,
    });
    return true;
  }

  return false;
};

// Fold a single JSONL line into the parser state, emitting zero or more
// ToolCall records via the callback. Malformed lines are silently skipped.
export const feedLine = (
  line: string,
  state: ParserState,
  emit: (call: ToolCall) => void,
): void => {
  if (!line) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const obj = parsed as Record<string, unknown>;
  upgradeIdentity(obj, state);
  if (extractCodex(obj, state, emit)) return;
  extractClaudeToolUses(obj, state);
  extractClaudeToolResults(obj, state, emit);
};
