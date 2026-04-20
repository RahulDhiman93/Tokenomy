import { existsSync, readFileSync } from "node:fs";
import { atomicWrite } from "./atomic.js";
import { safeParse } from "./json.js";
import { claudeUserConfigPath } from "../core/paths.js";

// ~/.claude.json is Claude Code's user-level config (distinct from
// ~/.claude/settings.json). It carries many internal fields we must not
// touch (onboarding state, OAuth tokens, cache timestamps, etc.), so all
// writes here are surgical: read → mutate only `mcpServers[name]` → write.
//
// File missing / unparseable → treat as empty object and write from there.
// This matches how `claude mcp add` behaves.

interface ClaudeUserConfig {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface McpStdioServer {
  type: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

const readConfig = (): ClaudeUserConfig => {
  const path = claudeUserConfigPath();
  if (!existsSync(path)) return {};
  const parsed = safeParse<ClaudeUserConfig>(readFileSync(path, "utf8"));
  return parsed ?? {};
};

// Upsert a stdio MCP server entry. Preserves all non-mcpServers keys and
// any sibling servers Claude Code or the user added separately.
export const upsertClaudeMcpServer = (
  name: string,
  server: { command: string; args: string[]; env?: Record<string, string> },
): void => {
  const cfg = readConfig();
  const entry: McpStdioServer = {
    type: "stdio",
    command: server.command,
    args: server.args,
    env: server.env ?? {},
  };
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: entry };
  atomicWrite(claudeUserConfigPath(), JSON.stringify(cfg, null, 2) + "\n", false);
};

export const removeClaudeMcpServer = (name: string): boolean => {
  const cfg = readConfig();
  if (!cfg.mcpServers || !(name in cfg.mcpServers)) return false;
  const nextServers = { ...cfg.mcpServers };
  delete nextServers[name];
  if (Object.keys(nextServers).length === 0) delete cfg.mcpServers;
  else cfg.mcpServers = nextServers;
  atomicWrite(claudeUserConfigPath(), JSON.stringify(cfg, null, 2) + "\n", false);
  return true;
};

export const getClaudeMcpServer = (name: string): unknown =>
  readConfig().mcpServers?.[name];
