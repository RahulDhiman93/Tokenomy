import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { safeParse } from "../util/json.js";
import type {
  KratosFinding,
  KratosHook,
  KratosMcpServer,
  KratosScanReport,
  KratosSeverity,
} from "./schema.js";

// `tokenomy kratos scan` — static audit of every agent config Tokenomy knows
// about. Read-only. Surfaces:
//   - registered MCP servers (per agent), classified as read-source vs
//     write-sink based on tool-name keywords and command/URL hints
//   - read↔sink combinations on the same agent (the actual exfil route)
//   - non-vetted MCP commands (network URLs we don't recognize, scripts in
//     home-dir-untracked locations)
//   - hooks registered outside Tokenomy ownership
//   - suspicious lines in ~/.tokenomy/savings.jsonl that look like
//     credentials slipped past redact

const SEVERITY_RANK: Record<KratosSeverity, number> = {
  info: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const max = (a: KratosSeverity, b: KratosSeverity): KratosSeverity =>
  SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;

const READ_SOURCE_HINTS = [
  "read", "get", "fetch", "list", "search", "query", "describe", "show",
  "load", "download", "export", "dump", "browse", "find", "lookup",
];

const WRITE_SINK_HINTS = [
  "send", "post", "create", "write", "publish", "share", "comment",
  "upload", "push", "transmit", "email", "message", "webhook", "notify",
  "deliver", "tweet", "draft",
];

const VETTED_LOCAL_COMMANDS = new Set([
  "tokenomy",
  "tokenomy-graph",
  "node",
  "npx",
  "uv",
  "uvx",
  "python",
  "python3",
]);

interface AgentConfigPath {
  agent: string;
  path: string;
  shape: "claude-code" | "claude-json" | "codex-toml" | "cursor" | "windsurf" | "cline" | "gemini";
}

const candidatePaths = (): AgentConfigPath[] => {
  const home = homedir();
  return [
    { agent: "claude-code", path: join(home, ".claude", "settings.json"), shape: "claude-code" },
    { agent: "claude-code", path: join(home, ".claude.json"), shape: "claude-json" },
    { agent: "codex", path: join(home, ".codex", "config.toml"), shape: "codex-toml" },
    { agent: "cursor", path: join(home, ".cursor", "mcp.json"), shape: "cursor" },
    { agent: "windsurf", path: join(home, ".codeium", "windsurf", "mcp_config.json"), shape: "windsurf" },
    { agent: "cline", path: join(home, ".cline", "mcp_settings.json"), shape: "cline" },
    { agent: "gemini", path: join(home, ".gemini", "settings.json"), shape: "gemini" },
  ];
};

const readJson = (path: string): unknown => {
  if (!existsSync(path)) return null;
  try {
    return safeParse<unknown>(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

// Minimal TOML extractor for Codex's `~/.codex/config.toml`. We parse just
// enough to recover `[mcp_servers.<name>]` tables — command, args, env, url.
// Everything else is ignored. Codex doesn't expose a JS-side TOML parser;
// shipping a generic dep for one section would be over-budget for kratos.
const readCodexMcpServers = (path: string, agent: string): KratosMcpServer[] => {
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: KratosMcpServer[] = [];
  const lines = text.split("\n");
  let currentName: string | null = null;
  let entry: Record<string, unknown> = {};
  const flush = (): void => {
    if (currentName === null) return;
    const command = typeof entry["command"] === "string" ? (entry["command"] as string) : undefined;
    const args = Array.isArray(entry["args"])
      ? (entry["args"] as unknown[]).filter((v): v is string => typeof v === "string")
      : undefined;
    const env =
      entry["env"] && typeof entry["env"] === "object" && !Array.isArray(entry["env"])
        ? Object.fromEntries(
            Object.entries(entry["env"] as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
          )
        : undefined;
    const url = typeof entry["url"] === "string" ? (entry["url"] as string) : undefined;
    out.push({
      source: path,
      agent,
      name: currentName,
      ...(command ? { command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(env ? { env } : {}),
      ...(url ? { url } : {}),
    });
    currentName = null;
    entry = {};
  };
  // Match `[mcp_servers.<name>]` at line start. Codex also accepts
  // `[mcp_servers."hyphenated-name"]` (quoted). Both forms covered.
  const HEADER = /^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_\-]+))\]\s*$/;
  // Bare scalar / array / inline-table assignment lines inside the table.
  const ASSIGN = /^\s*([A-Za-z0-9_\-]+)\s*=\s*(.+?)\s*$/;
  const parseValue = (raw: string): unknown => {
    const trimmed = raw.trim().replace(/\s*#.*$/, "");
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1);
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const inner = trimmed.slice(1, -1);
      // Naive split on commas that don't fall inside quotes — sufficient for
      // typical "args" arrays of plain strings.
      const items: string[] = [];
      let buf = "";
      let inStr = false;
      let quote = "";
      for (const ch of inner) {
        if (inStr) {
          if (ch === quote) inStr = false;
          buf += ch;
        } else if (ch === '"' || ch === "'") {
          inStr = true;
          quote = ch;
          buf += ch;
        } else if (ch === ",") {
          items.push(buf.trim());
          buf = "";
        } else {
          buf += ch;
        }
      }
      if (buf.trim().length > 0) items.push(buf.trim());
      return items.map((it) => parseValue(it));
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      const inner = trimmed.slice(1, -1);
      const obj: Record<string, unknown> = {};
      // Naive inline-table split. Same caveats as the array case.
      let buf = "";
      let inStr = false;
      let quote = "";
      const parts: string[] = [];
      for (const ch of inner) {
        if (inStr) {
          if (ch === quote) inStr = false;
          buf += ch;
        } else if (ch === '"' || ch === "'") {
          inStr = true;
          quote = ch;
          buf += ch;
        } else if (ch === ",") {
          parts.push(buf.trim());
          buf = "";
        } else {
          buf += ch;
        }
      }
      if (buf.trim().length > 0) parts.push(buf.trim());
      for (const part of parts) {
        const m = part.match(/^([A-Za-z0-9_\-]+)\s*=\s*(.+)$/);
        if (m && m[1] && m[2]) obj[m[1]] = parseValue(m[2]);
      }
      return obj;
    }
    if (/^-?\d+$/.test(trimmed)) return parseInt(trimmed, 10);
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return trimmed;
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s*#.*$/, "").replace(/(?<!\\)#.*$/, "");
    const headerMatch = line.match(HEADER);
    if (headerMatch) {
      flush();
      currentName = headerMatch[1] ?? headerMatch[2] ?? null;
      continue;
    }
    if (line.match(/^\s*\[/)) {
      // Some other table section — flush the in-progress mcp_servers entry
      // and stop accumulating until the next `[mcp_servers.x]` header.
      flush();
      currentName = null;
      continue;
    }
    if (currentName === null) continue;
    const assignMatch = line.match(ASSIGN);
    if (!assignMatch) continue;
    const key = assignMatch[1];
    const rawVal = assignMatch[2];
    if (typeof key !== "string" || typeof rawVal !== "string") continue;
    entry[key] = parseValue(rawVal);
  }
  flush();
  return out;
};

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Lightly hand-rolled MCP-server extractors. Each agent stores them in a
// slightly different shape, so we normalize to a common KratosMcpServer.
const extractMcpServers = (configPath: AgentConfigPath): KratosMcpServer[] => {
  const json = readJson(configPath.path);
  if (!json) return [];
  const out: KratosMcpServer[] = [];
  const obj = asObj(json);

  // Claude Code stores per-project mcpServers under projects[<repo>].mcpServers
  // and global ones under top-level mcpServers.
  if (configPath.shape === "claude-json") {
    for (const map of [asObj(obj["mcpServers"]), ...Object.values(asObj(obj["projects"])).map(asObj).map((p) => asObj(p["mcpServers"]))]) {
      for (const [name, raw] of Object.entries(map)) {
        const entry = asObj(raw);
        out.push({
          source: configPath.path,
          agent: configPath.agent,
          name,
          ...(asStr(entry["command"]) ? { command: asStr(entry["command"]) } : {}),
          ...(Array.isArray(entry["args"]) ? { args: (entry["args"] as unknown[]).filter((a): a is string => typeof a === "string") } : {}),
          ...(asObj(entry["env"]) ? { env: Object.fromEntries(Object.entries(asObj(entry["env"])).map(([k, v]) => [k, String(v)])) } : {}),
          ...(asStr(entry["url"]) ? { url: asStr(entry["url"]) } : {}),
        });
      }
    }
    return out;
  }

  // Cursor / Windsurf / Cline / Gemini all use a top-level `mcpServers` map.
  const map = asObj(obj["mcpServers"]);
  for (const [name, raw] of Object.entries(map)) {
    const entry = asObj(raw);
    out.push({
      source: configPath.path,
      agent: configPath.agent,
      name,
      ...(asStr(entry["command"]) ? { command: asStr(entry["command"]) } : {}),
      ...(Array.isArray(entry["args"]) ? { args: (entry["args"] as unknown[]).filter((a): a is string => typeof a === "string") } : {}),
      ...(asObj(entry["env"]) ? { env: Object.fromEntries(Object.entries(asObj(entry["env"])).map(([k, v]) => [k, String(v)])) } : {}),
      ...(asStr(entry["url"]) ? { url: asStr(entry["url"]) } : {}),
    });
  }
  return out;
};

const classifyServer = (server: KratosMcpServer): KratosMcpServer => {
  const name = server.name.toLowerCase();
  const reasons: string[] = [];
  // Name-based heuristic — most MCP server names announce intent (e.g.
  // `slack`, `gmail`, `confluence`). Check for read vs write keywords.
  let readSource = false;
  let writeSink = false;
  for (const hint of READ_SOURCE_HINTS) {
    if (name.includes(hint)) {
      readSource = true;
      reasons.push(`name contains read-hint "${hint}"`);
      break;
    }
  }
  for (const hint of WRITE_SINK_HINTS) {
    if (name.includes(hint)) {
      writeSink = true;
      reasons.push(`name contains write-hint "${hint}"`);
      break;
    }
  }
  // Domain heuristic. Big read-write surfaces — Slack, Gmail, Atlassian,
  // Asana, HubSpot, Intercom, Notion, monday — by convention have BOTH
  // read tools and write tools, so they qualify as both source and sink.
  const dualSurfaces = [
    "slack", "gmail", "atlassian", "jira", "confluence", "asana", "hubspot",
    "intercom", "notion", "monday", "linear", "drive", "github", "box",
  ];
  for (const surface of dualSurfaces) {
    if (name.includes(surface)) {
      readSource = true;
      writeSink = true;
      reasons.push(`recognized dual-surface integration "${surface}"`);
      break;
    }
  }
  // Local Tokenomy graph server is read-only by design. Hard-code so we
  // don't flag our own surface.
  if (name === "tokenomy-graph") {
    readSource = true;
    writeSink = false;
    reasons.length = 0;
    reasons.push("tokenomy-graph: local read-only graph queries");
  }
  return { ...server, readSource, writeSink, reasons };
};

const extractClaudeHooks = (path: string): KratosHook[] => {
  const json = readJson(path);
  if (!json) return [];
  const hooks = asObj(asObj(json)["hooks"]);
  const out: KratosHook[] = [];
  for (const [event, raw] of Object.entries(hooks)) {
    const arr = asArr(raw);
    for (const entry of arr) {
      const e = asObj(entry);
      const matcher = asStr(e["matcher"]) ?? "*";
      const inner = asArr(e["hooks"]);
      for (const h of inner) {
        const hh = asObj(h);
        const command = asStr(hh["command"]);
        if (!command) continue;
        out.push({ source: path, agent: "claude-code", event, matcher, command });
      }
    }
  }
  return out;
};

const flagUntrustedServer = (server: KratosMcpServer): KratosFinding[] => {
  const out: KratosFinding[] = [];
  // HTTP-transport MCPs are trust-on-first-use against a remote endpoint.
  if (server.url && /^https?:\/\//i.test(server.url) && !/localhost|127\.0\.0\.1/.test(server.url)) {
    out.push({
      category: "mcp-untrusted-server",
      severity: "high",
      confidence: "medium",
      title: `Remote MCP server: ${server.name}`,
      detail:
        `MCP server "${server.name}" registered for ${server.agent} points at a remote URL ` +
        `(${server.url}). Anything the agent reads on this connection comes from a third party. ` +
        "Verify the endpoint is operated by you or a vendor you trust.",
      evidence: server.source,
      fix: "Pin the URL to a known host, or move the integration behind a local proxy you control.",
    });
  }
  if (server.command && !VETTED_LOCAL_COMMANDS.has(server.command.split("/").pop() ?? server.command)) {
    out.push({
      category: "mcp-untrusted-server",
      severity: "medium",
      confidence: "low",
      title: `Non-vetted MCP launch command: ${server.command}`,
      detail:
        `MCP server "${server.name}" launches via a command Tokenomy doesn't vet by default. ` +
        "This is fine if you installed the server yourself; flagged so you can confirm nothing " +
        "modified the launch line.",
      evidence: `${server.command} ${(server.args ?? []).join(" ")}`,
      fix: "If unfamiliar, remove the entry with the agent's MCP-uninstall command and re-add explicitly.",
    });
  }
  return out;
};

// Hook audit. Two categories:
//
//   hook-overbroad: a UserPromptSubmit / SessionStart entry whose `matcher`
//                   doesn't constrain to a known event-shape, or a
//                   PreToolUse / PostToolUse entry with `matcher: "*"` or
//                   empty — these touch every tool call, so a hostile or
//                   buggy hook here gets maximum reach.
//   config-drift:   a hook command that doesn't run a vetted Tokenomy
//                   binary AND isn't running an obvious user binary
//                   (node / npx / python / sh path under their own home).
//                   Surfaces foreign hooks the user may have forgotten or
//                   that some other tool injected without their knowledge.
const flagHooks = (hooks: KratosHook[]): KratosFinding[] => {
  const out: KratosFinding[] = [];
  const TOKENOMY_HINTS = ["tokenomy-hook", "tokenomy", "/.tokenomy/bin/"];
  const isVettedCommand = (cmd: string): boolean =>
    TOKENOMY_HINTS.some((h) => cmd.includes(h));
  for (const hook of hooks) {
    const wide = hook.matcher === "" || hook.matcher === "*" || hook.matcher === ".*";
    if (wide && (hook.event === "PreToolUse" || hook.event === "PostToolUse")) {
      out.push({
        category: "hook-overbroad",
        severity: "medium",
        confidence: "medium",
        title: `Overbroad ${hook.event} matcher: "${hook.matcher || "(empty)"}"`,
        detail:
          `Hook on ${hook.event} matches every tool. Any bug or compromise in this hook ` +
          "reaches every Read/Write/Bash/MCP call. Prefer a tighter matcher (e.g. " +
          "`Read|Bash|Write` or `mcp__.*`) so the blast radius matches the hook's purpose.",
        evidence: `${hook.source} → ${hook.event}: ${hook.command}`,
        fix: "Edit ~/.claude/settings.json to constrain the matcher to the tools the hook actually needs.",
      });
    }
    if (!isVettedCommand(hook.command)) {
      out.push({
        category: "config-drift",
        severity: "medium",
        confidence: "low",
        title: `Foreign hook command on ${hook.event}`,
        detail:
          `Hook command does not look like a Tokenomy binary. This is fine if you installed ` +
          "another tool's hook on purpose (e.g. a project lint hook); flagged so you can " +
          "confirm nothing was injected without your knowledge.",
        evidence: `${hook.command} (matcher: ${hook.matcher})`,
        fix: "Run `tokenomy doctor` to confirm Tokenomy hooks are intact; remove unknown entries.",
      });
    }
  }
  return out;
};

const flagExfilPairs = (servers: KratosMcpServer[]): KratosFinding[] => {
  const out: KratosFinding[] = [];
  // Group by agent so we only pair servers reachable to the same client.
  const byAgent = new Map<string, KratosMcpServer[]>();
  for (const s of servers) {
    if (!byAgent.has(s.agent)) byAgent.set(s.agent, []);
    byAgent.get(s.agent)!.push(s);
  }
  for (const [agent, list] of byAgent) {
    const sources = list.filter((s) => s.readSource);
    const sinks = list.filter((s) => s.writeSink);
    if (sources.length === 0 || sinks.length === 0) continue;
    for (const source of sources) {
      for (const sink of sinks) {
        if (source.name === sink.name) continue; // dual-surface server is a single risk surface, not a pair
        out.push({
          category: "mcp-exfil-pair",
          severity: "high",
          confidence: "medium",
          title: `Exfil-capable MCP pair on ${agent}: ${source.name} → ${sink.name}`,
          detail:
            `"${source.name}" can pull data from external systems and "${sink.name}" can post ` +
            `to external systems. A prompt-injection or a confused-deputy bug could chain them ` +
            "into an exfil channel. The risk is structural — both tools may be perfectly fine in " +
            "isolation.",
          evidence: `${source.source} | ${sink.source}`,
          fix:
            "Disable whichever side you don't need in this project, or scope the agent's " +
            "permission_mode so the sink server can't be invoked without explicit approval.",
        });
      }
    }
    // Dual-surface servers (Slack, Gmail, Atlassian) are themselves a self-
    // contained exfil route — read-and-post on the same connector.
    for (const s of list) {
      if (s.readSource && s.writeSink && (s.reasons ?? []).some((r) => r.startsWith("recognized dual-surface"))) {
        out.push({
          category: "mcp-exfil-pair",
          severity: "medium",
          confidence: "medium",
          title: `Dual-surface MCP server on ${agent}: ${s.name}`,
          detail:
            `"${s.name}" exposes both read and write tools on the same connection. ` +
            "Prompt-injection chained against this server alone can move data within its tenant " +
            "(e.g. read a private channel + post to a public one).",
          evidence: s.source,
          fix:
            "If you only need read access, install the read-only variant of this MCP. " +
            "Otherwise rely on the prompt-time injection check + caller approval.",
        });
      }
    }
  }
  return out;
};

const SECRET_RX_FOR_LOG = [
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36,}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bsk-ant-[A-Za-z0-9-]{32,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z\-_]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

// Read the last `tailBytes` bytes of a file without loading the whole file.
// Critical on long-lived installs where ~/.tokenomy/savings.jsonl can be
// hundreds of MB — earlier readFileSync-then-slice version scaled memory
// + runtime with the entire log size despite the cap.
const readTail = (path: string, tailBytes: number): string => {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    const bytes = Math.min(stat.size, tailBytes);
    if (bytes === 0) return "";
    const start = Math.max(0, stat.size - bytes);
    fd = openSync(path, "r");
    const buf = Buffer.alloc(bytes);
    const read = readSync(fd, buf, 0, bytes, start);
    return buf.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
};

const flagTranscriptLeak = (logPath: string): KratosFinding[] => {
  if (!existsSync(logPath)) return [];
  // Cap: only scan the most recent 1 MB of the log.
  const tailBytes = 1_000_000;
  const chunk = readTail(logPath, tailBytes);
  if (chunk.length === 0) return [];
  for (const rx of SECRET_RX_FOR_LOG) {
    const m = chunk.match(rx);
    if (!m) continue;
    return [
      {
        category: "transcript-leak",
        severity: "critical",
        confidence: "high",
        title: "Credential-shaped string in savings.jsonl",
        detail:
          "Tokenomy's own savings log contains a string matching a known credential format. " +
          "Either redact-pre is off, or a tool input bypassed it. Rotate the credential and " +
          "enable `cfg.redact.pre_tool_use = true` if not already on.",
        evidence: `${logPath} (~${chunk.length} bytes scanned)`,
        fix: "Rotate the leaked credential; truncate ~/.tokenomy/savings.jsonl; enable redact.pre_tool_use.",
      },
    ];
  }
  return [];
};

export const runKratosScan = (logPath: string): KratosScanReport => {
  const allServers: KratosMcpServer[] = [];
  const findings: KratosFinding[] = [];
  const hooks: KratosHook[] = [];
  for (const cfg of candidatePaths()) {
    if (!existsSync(cfg.path)) continue;
    if (cfg.shape === "claude-code") {
      hooks.push(...extractClaudeHooks(cfg.path));
      continue;
    }
    const servers =
      cfg.shape === "codex-toml"
        ? readCodexMcpServers(cfg.path, cfg.agent).map(classifyServer)
        : extractMcpServers(cfg).map(classifyServer);
    allServers.push(...servers);
    for (const s of servers) findings.push(...flagUntrustedServer(s));
  }
  findings.push(...flagExfilPairs(allServers));
  findings.push(...flagHooks(hooks));
  findings.push(...flagTranscriptLeak(logPath));

  const counts: Record<KratosSeverity, number> = { info: 0, medium: 0, high: 0, critical: 0 };
  let worst: KratosSeverity = "info";
  for (const f of findings) {
    counts[f.severity] += 1;
    worst = max(worst, f.severity);
  }
  return {
    schema_version: 1,
    scanned_at: new Date().toISOString(),
    findings,
    mcp_servers: allServers,
    hooks,
    worst,
    counts,
  };
};

// Used by the CLI to format scan output. Pure render; no I/O.
export const formatKratosScan = (report: KratosScanReport): string => {
  const lines: string[] = [];
  lines.push(`Kratos scan @ ${report.scanned_at}`);
  lines.push(
    `  servers=${report.mcp_servers.length}  hooks=${report.hooks.length}  ` +
      `findings=${report.findings.length}  worst=${report.worst}`,
  );
  lines.push(
    `  counts: critical=${report.counts.critical} high=${report.counts.high} ` +
      `medium=${report.counts.medium} info=${report.counts.info}`,
  );
  if (report.findings.length === 0) {
    lines.push("\n✓ No findings.");
    return lines.join("\n");
  }
  lines.push("");
  for (const f of report.findings) {
    lines.push(`[${f.severity.toUpperCase()}/${f.confidence}] ${f.category} — ${f.title}`);
    lines.push(`  ${f.detail}`);
    if (f.evidence) lines.push(`  evidence: ${f.evidence}`);
    if (f.fix) lines.push(`  fix: ${f.fix}`);
    lines.push("");
  }
  return lines.join("\n");
};

// readDirSafe is exported only for tests.
export const _internal = { readdirSync };
