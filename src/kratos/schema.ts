// Kratos — Tokenomy's security shield. Detects prompt-injection / data-
// exfil patterns in user prompts at UserPromptSubmit time, and audits the
// installed agent surface (hooks + MCP servers) for known leak routes.
//
// Two modes of operation:
//   1. Continuous (UserPromptSubmit hook). Inspects every prompt for
//      injection/exfil patterns and emits a `[tokenomy-kratos]` warning
//      via additionalContext. Never blocks — fail-open is non-negotiable.
//   2. On-demand (`tokenomy kratos scan`). Static audit of the user's
//      Claude Code / Codex / Cursor / Windsurf / Cline / Gemini configs:
//      enumerates registered MCP servers, classifies each as read-source
//      vs write-sink, flags read↔sink pairs that form an exfil route.
//
// Severity ladder (ranked by reviewer attention budget):
//   info:    advisory; the user might want to know
//   medium:  one cause for concern, not a smoking gun on its own
//   high:    likely real risk; reviewer should examine before next session
//   critical: clear leak path or active injection; must be acknowledged
//
// Confidence ladder:
//   high:   pattern match on a known-bad signature
//   medium: heuristic match — most matches in practice are real
//   low:    advisory pattern; many false positives expected

export type KratosSeverity = "info" | "medium" | "high" | "critical";
export type KratosConfidence = "low" | "medium" | "high";

export type KratosCategory =
  | "prompt-injection"        // user-prompt attempts to override agent rules
  | "data-exfil"              // outbound exfiltration request in user prompt
  | "secret-in-prompt"        // user pasted a credential-shaped string
  | "encoded-payload"         // base64/hex/zero-width hidden content
  | "mcp-exfil-pair"          // a read-source + write-sink combo on the same agent
  | "mcp-untrusted-server"    // MCP server pointing at a non-vetted command/URL
  | "hook-overbroad"          // hook matcher covers more tools than declared
  | "config-drift"            // settings.json modified outside Tokenomy ownership
  | "transcript-leak";        // savings.jsonl / analyze contains a credential

export interface KratosFinding {
  category: KratosCategory;
  severity: KratosSeverity;
  confidence: KratosConfidence;
  title: string;
  detail: string;
  // For prompt-time findings: the offending substring (already truncated to
  // ≤ 200 chars + redacted of any obvious secrets). For scan findings: the
  // file path or MCP server name involved.
  evidence?: string;
  // Suggested mitigation. Always actionable, never just "review this".
  fix?: string;
}

export interface KratosPromptResult {
  flagged: boolean;
  findings: KratosFinding[];
  // Single-line additionalContext built from the findings. Empty string
  // when not flagged. Always starts with `[tokenomy-kratos:` so the
  // assistant can pattern-match and refuse appropriately.
  notice: string;
}

export interface KratosMcpServer {
  source: string;       // config file path the server was loaded from
  agent: string;        // claude-code | codex | cursor | windsurf | cline | gemini
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;         // for HTTP-transport servers
  // Tooling classification (filled by classify):
  readSource?: boolean; // can pull data from external systems
  writeSink?: boolean;  // can post / send / write to external systems
  reasons?: string[];   // human-readable reasons for the classification
}

export interface KratosHook {
  source: string;
  agent: string;
  event: string;        // PreToolUse | PostToolUse | UserPromptSubmit | SessionStart
  matcher: string;
  command: string;
}

export interface KratosScanReport {
  schema_version: 1;
  scanned_at: string;
  findings: KratosFinding[];
  mcp_servers: KratosMcpServer[];
  hooks: KratosHook[];
  // Highest severity in `findings`, or "info" when empty.
  worst: KratosSeverity;
  // Aggregate counts for the CLI summary line.
  counts: Record<KratosSeverity, number>;
}

export interface KratosConfig {
  enabled: boolean;
  // Continuous prompt scanning (UserPromptSubmit). Off → kratos is purely
  // a CLI-driven static audit.
  continuous: boolean;
  // Per-category enable map. All on by default; users can silence noisy
  // categories without turning the whole shield off.
  categories: Record<KratosCategory, boolean>;
  // Minimum severity to surface in the per-prompt notice. Findings below
  // this threshold are still recorded in scan output but don't yell at the
  // assistant on every turn. Default "high".
  prompt_min_severity: KratosSeverity;
  // Length cap on the per-prompt notice (bytes). Past this, the notice is
  // truncated with `… (kratos: N more findings)`.
  notice_max_bytes: number;
}
