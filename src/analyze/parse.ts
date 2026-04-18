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

// Per-session bookkeeping carried across lines in a single file.
export interface ParserState {
  session_id: string;
  project_hint: string;
  pending: Map<string, RawToolUse>; // tool_use_id → tool use
}

export const makeState = (session_id: string, project_hint: string): ParserState => ({
  session_id,
  project_hint,
  pending: new Map(),
});

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

// Codex rollout shape: events look like
//   { "type":"event_msg", "payload": { "type":"tool_call", "tool":{...}, "result":{...} } }
// or separate function_call / function_call_output items. We accept any shape
// that exposes {tool_name, tool_input, tool_output} at a top-level key.
const extractCodex = (
  line: Record<string, unknown>,
  state: ParserState,
  emit: (call: ToolCall) => void,
): boolean => {
  // Heuristic: Codex rollout lines often carry "payload" or "item_type".
  const payload = asObject(line["payload"]);
  const item = asObject(line["item"]);
  const tc = asObject(payload["tool_call"] ?? item["tool_call"]);
  if (!tc || Object.keys(tc).length === 0) return false;
  const name = typeof tc["name"] === "string" ? (tc["name"] as string) : "";
  const input = asObject(tc["arguments"] ?? tc["input"]);
  const output = tc["output"] ?? tc["result"];
  if (!name) return false;
  const ts = typeof line["timestamp"] === "string" ? (line["timestamp"] as string) : "";
  const bytes = utf8Bytes(JSON.stringify(output ?? null));
  emit({
    agent: "codex",
    session_id: state.session_id,
    project_hint: state.project_hint,
    ts,
    tool_name: name,
    tool_input: input,
    tool_response: output,
    is_error: tc["is_error"] === true,
    response_bytes: bytes,
  });
  return true;
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
  if (extractCodex(obj, state, emit)) return;
  extractClaudeToolUses(obj, state);
  extractClaudeToolResults(obj, state, emit);
};
