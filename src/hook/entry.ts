#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dispatch } from "./dispatch.js";
import { preDispatch, dispatchUserPrompt } from "./pre-dispatch.js";
import { loadConfig } from "../core/config.js";
import { tokenomyDir } from "../core/paths.js";
import type {
  HookInput,
  PreHookInput,
  UserPromptHookInput,
} from "../core/types.js";

// Returns a shallow, size-capped snapshot of the tool_input for diagnostics.
// Strings longer than 200 chars are truncated; unknown types are stringified.
const previewToolInput = (
  input: Record<string, unknown> | undefined,
  toolName?: string,
): Record<string, unknown> => {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (toolName === "Write" && k === "content") {
      out[k] = "<redacted: Write content>";
      continue;
    }
    if (typeof v === "string") {
      out[k] = v.length > 200 ? v.slice(0, 200) + "…" : v;
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[k] = v;
    } else {
      out[k] = `<${typeof v}>`;
    }
  }
  return out;
};

const debugLog = (entry: Record<string, unknown>): void => {
  try {
    const path = `${tokenomyDir()}/debug.jsonl`;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // ignore
  }
};

const MAX_STDIN_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 2_500;

const readStdin = (): Promise<Buffer | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, TIMEOUT_MS);
    timer.unref();

    process.stdin.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_STDIN_BYTES) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      }
    });
    process.stdin.on("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });

const main = async (): Promise<void> => {
  const hookStart = Date.now();
  try {
    const buf = await readStdin();
    if (!buf) {
      debugLog({ phase: "stdin-empty-or-capped" });
      process.exit(0);
      return;
    }

    let parsed: HookInput | PreHookInput | UserPromptHookInput;
    try {
      parsed = JSON.parse(buf.toString("utf8")) as
        | HookInput
        | PreHookInput
        | UserPromptHookInput;
    } catch {
      debugLog({ phase: "parse-fail", stdin_bytes: buf.length });
      process.exit(0);
      return;
    }

    const cfg = loadConfig(parsed?.cwd ?? process.cwd());

    if (parsed?.hook_event_name === "UserPromptSubmit") {
      const promptInput = parsed as UserPromptHookInput;
      const out = dispatchUserPrompt(promptInput, cfg);
      debugLog({
        phase: out ? "prompt-nudged" : "prompt-passthrough",
        session_id: promptInput.session_id,
        event: "UserPromptSubmit",
        elapsed_ms: Date.now() - hookStart,
        prompt_len: promptInput.prompt?.length ?? 0,
      });
      if (out) process.stdout.write(JSON.stringify(out));
      process.exit(0);
      return;
    }

    if (parsed?.hook_event_name === "PreToolUse") {
      const preInput = parsed as PreHookInput;
      const preOut = preDispatch(preInput, cfg);
      debugLog({
        phase: preOut ? "pre-clamped" : "pre-passthrough",
        session_id: preInput.session_id,
        tool: preInput.tool_name,
        event: "PreToolUse",
        elapsed_ms: Date.now() - hookStart,
        // Diagnostics for Phase-1 passthrough investigations: capture the
        // first-order tool_input fields so we can see whether e.g. Claude
        // Code sent a relative path or an explicit limit.
        tool_input_preview: previewToolInput(preInput.tool_input, preInput.tool_name),
      });
      if (preOut) process.stdout.write(JSON.stringify(preOut));
      process.exit(0);
      return;
    }

    const evt = (parsed as { hook_event_name?: string } | null)?.hook_event_name;
    if (evt !== "PostToolUse") {
      debugLog({ phase: "wrong-event", event: evt });
      process.exit(0);
      return;
    }

    const input = parsed as HookInput;
    const respBytes = Buffer.byteLength(JSON.stringify(input.tool_response ?? null), "utf8");
    const output = dispatch(input, cfg);

    const resp = input.tool_response as Record<string, unknown> | null;
    const topKeys =
      resp && typeof resp === "object" && !Array.isArray(resp)
        ? Object.keys(resp)
        : Array.isArray(resp)
        ? ["<array>"]
        : [typeof resp];
    let contentShape = "none";
    if (resp && typeof resp === "object" && "content" in resp) {
      const c = (resp as { content: unknown }).content;
      contentShape = Array.isArray(c)
        ? `array[${c.length}] types=[${c
            .map((b) => (b && typeof b === "object" ? (b as { type?: string }).type ?? "?" : typeof b))
            .slice(0, 5)
            .join(",")}]`
        : typeof c;
    }
    debugLog({
      phase: output ? "trimmed" : "passthrough",
      session_id: input.session_id,
      tool: input.tool_name,
      is_mcp: input.tool_name?.startsWith("mcp__") ?? false,
      response_bytes: respBytes,
      top_keys: topKeys,
      content_shape: contentShape,
      elapsed_ms: Date.now() - hookStart,
    });
    if (output) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch (e) {
    debugLog({ phase: "error", err: (e as Error).message });
    process.exit(0);
  }
};

void main();
