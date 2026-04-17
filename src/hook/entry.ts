#!/usr/bin/env node
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { dispatch } from "./dispatch.js";
import { preDispatch } from "./pre-dispatch.js";
import { loadConfig } from "../core/config.js";
import { tokenomyDir } from "../core/paths.js";
import type { HookInput, PreHookInput } from "../core/types.js";

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
  try {
    const buf = await readStdin();
    if (!buf) {
      debugLog({ phase: "stdin-empty-or-capped" });
      process.exit(0);
      return;
    }

    let parsed: HookInput | PreHookInput;
    try {
      parsed = JSON.parse(buf.toString("utf8")) as HookInput | PreHookInput;
    } catch {
      debugLog({ phase: "parse-fail", stdin_bytes: buf.length });
      process.exit(0);
      return;
    }

    const cfg = loadConfig(parsed?.cwd ?? process.cwd());

    if (parsed?.hook_event_name === "PreToolUse") {
      const preInput = parsed as PreHookInput;
      const preOut = preDispatch(preInput, cfg);
      debugLog({
        phase: preOut ? "pre-clamped" : "pre-passthrough",
        session_id: preInput.session_id,
        tool: preInput.tool_name,
        event: "PreToolUse",
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
    });
    if (output) process.stdout.write(JSON.stringify(output));
    process.exit(0);
  } catch (e) {
    debugLog({ phase: "error", err: (e as Error).message });
    process.exit(0);
  }
};

void main();
