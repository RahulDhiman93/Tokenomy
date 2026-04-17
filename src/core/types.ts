export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; [k: string]: unknown }
  | { type: "resource"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export type McpToolResponse = {
  content?: McpContentBlock[];
  is_error?: boolean;
  [k: string]: unknown;
};

export interface HookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
  tool_response: unknown;
}

export interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PostToolUse";
    updatedMCPToolOutput: McpToolResponse;
  };
}

export interface PreHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PreHookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    updatedInput: Record<string, unknown>;
    additionalContext?: string;
  };
}

export type RuleResult =
  | { kind: "passthrough" }
  | {
      kind: "trim";
      output: McpToolResponse;
      bytesIn: number;
      bytesOut: number;
      reason: string;
    };

export type Rule = (
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResponse: unknown,
  cfg: Config,
) => RuleResult;

export interface GateConfig {
  always_trim_above_bytes: number;
  min_saved_bytes: number;
  min_saved_pct: number;
}

export interface McpRuleConfig {
  max_text_bytes: number;
  per_block_head: number;
  per_block_tail: number;
}

export interface ReadRuleConfig {
  enabled: boolean;
  clamp_above_bytes: number;
  injected_limit: number;
}

export interface Config {
  aggression: "conservative" | "balanced" | "aggressive";
  gate: GateConfig;
  mcp: McpRuleConfig;
  read: ReadRuleConfig;
  log_path: string;
  disabled_tools: string[];
}

export interface SavingsLogEntry {
  ts: string;
  session_id: string;
  tool: string;
  bytes_in: number;
  bytes_out: number;
  tokens_saved_est: number;
  reason: string;
}

export interface ManifestEntry {
  command_path: string;
  settings_path: string;
  matcher: string;
  installed_at: string;
}

export interface Manifest {
  version: 1;
  entries: ManifestEntry[];
}
