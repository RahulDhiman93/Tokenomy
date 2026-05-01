import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { atomicWrite } from "../../util/atomic.js";
import { backupFile } from "../../util/backup.js";
import { safeParse, stableStringify } from "../../util/json.js";

export type AgentName = "claude-code" | "codex" | "cursor" | "windsurf" | "cline" | "gemini";

export interface AgentInstallResult {
  agent: AgentName;
  installed: boolean;
  detail: string;
  backupPath?: string | null;
}

export interface AgentAdapter {
  name: AgentName;
  configPath?: () => string;
  detect: () => boolean;
  install: (graphPath: string, backup: boolean) => AgentInstallResult;
  uninstall?: (backup: boolean) => AgentInstallResult;
}

const COMMAND_EXISTS_TIMEOUT_MS = 1_000;

// 0.1.7+: Windows uses `where.exe`, not `which`. Pre-0.1.7 every adapter
// `detect()` returned false on Windows because `which` doesn't exist on
// stock cmd/PowerShell, so `tokenomy init` reported "no agents detected"
// even when codex.exe / claude.exe were on PATH.
export const commandExists = (cmd: string): boolean => {
  const probe = process.platform === "win32" ? "where" : "which";
  return (
    spawnSync(probe, [cmd], {
      encoding: "utf8",
      timeout: COMMAND_EXISTS_TIMEOUT_MS,
    }).status === 0
  );
};

export const homePath = (...parts: string[]): string => join(homedir(), ...parts);

const graphServer = (graphPath: string): Record<string, unknown> => ({
  command: "tokenomy",
  args: ["graph", "serve", "--path", graphPath],
});

export const patchMcpJson = (
  agent: AgentName,
  path: string,
  graphPath: string,
  backup: boolean,
): AgentInstallResult => {
  mkdirSync(dirname(path), { recursive: true });
  const before = existsSync(path) ? safeParse<Record<string, unknown>>(readFileSync(path, "utf8")) : {};
  if (!before) {
    return { agent, installed: false, detail: `invalid JSON: ${path}` };
  }
  const backupPath = backup ? backupFile(path) : null;
  const mcpServers =
    before.mcpServers && typeof before.mcpServers === "object" && !Array.isArray(before.mcpServers)
      ? (before.mcpServers as Record<string, unknown>)
      : {};
  const next = {
    ...before,
    mcpServers: {
      ...mcpServers,
      "tokenomy-graph": graphServer(graphPath),
    },
  };
  atomicWrite(path, stableStringify(next) + "\n", false);
  return { agent, installed: true, detail: path, backupPath };
};

export const removeMcpJson = (
  agent: AgentName,
  path: string,
  backup: boolean,
): AgentInstallResult => {
  if (!existsSync(path)) return { agent, installed: false, detail: "config missing" };
  const before = safeParse<Record<string, unknown>>(readFileSync(path, "utf8"));
  if (!before) return { agent, installed: false, detail: `invalid JSON: ${path}` };
  const backupPath = backup ? backupFile(path) : null;
  const mcpServers =
    before.mcpServers && typeof before.mcpServers === "object" && !Array.isArray(before.mcpServers)
      ? { ...(before.mcpServers as Record<string, unknown>) }
      : {};
  delete mcpServers["tokenomy-graph"];
  const next = { ...before, mcpServers };
  if (Object.keys(mcpServers).length === 0) delete (next as { mcpServers?: unknown }).mcpServers;
  atomicWrite(path, stableStringify(next) + "\n", false);
  return { agent, installed: true, detail: path, backupPath };
};
