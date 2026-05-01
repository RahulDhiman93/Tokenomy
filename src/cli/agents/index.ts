import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentAdapter, AgentInstallResult, AgentName } from "./common.js";
import { commandExists, homePath, patchMcpJson, removeMcpJson } from "./common.js";
import { hookBinaryPath } from "../../core/paths.js";
import {
  removeCodexTokenomyHooks,
  upsertCodexTokenomyHooks,
} from "../../util/codex-config.js";

const CODEX_MCP_REMOVE_TIMEOUT_MS = 2_000;

// 0.1.7+: surgical fallback when `codex mcp remove` times out or exits
// non-zero. The CLI is the canonical path, but if it hangs we directly
// edit ~/.codex/config.toml to drop any `[mcp_servers.tokenomy-graph]`
// table so older installs heal even when Codex itself can't run. Bails
// when the config contains TOML triple-quoted multi-line strings (codex
// round 2 catch) — the regex is not TOML-aware so we'd risk matching
// `[mcp_servers.tokenomy-graph]` literal text inside a heredoc and
// truncating user content.
const surgicalRemoveCodexGraphMcp = (): boolean => {
  try {
    const path = join(homedir(), ".codex", "config.toml");
    if (!existsSync(path)) return false;
    const before = readFileSync(path, "utf8");
    if (before.includes('"""') || before.includes("'''")) return false;
    const re = /^\[mcp_servers\.tokenomy-graph\][^\n]*\n(?:(?!^\[)[^\n]*\n?)*/m;
    if (!re.test(before)) return false;
    const after = before.replace(re, "");
    if (after === before) return false;
    writeFileSync(path, after);
    return true;
  } catch {
    return false;
  }
};

const removeCodexGraphMcp = (): ReturnType<typeof spawnSync> => {
  const r = spawnSync("codex", ["mcp", "remove", "tokenomy-graph"], {
    stdio: "ignore",
    timeout: CODEX_MCP_REMOVE_TIMEOUT_MS,
  });
  if (r.status !== 0) {
    // CLI failed (timeout, hang, non-zero exit). Surgically drop the
    // table from config.toml so older installs still heal.
    surgicalRemoveCodexGraphMcp();
  }
  return r;
};

const codexInstall = (_graphPath: string, backup: boolean): AgentInstallResult => {
  if (!commandExists("codex")) {
    return { agent: "codex", installed: false, detail: "codex not on PATH" };
  }
  // Codex CLI currently probes configured MCP servers through its
  // codex_apps/mcp_servers flow. A user-scoped tokenomy-graph stdio server
  // can make that probe hang, so init heals older installs by removing it
  // and keeps Codex support to hooks only.
  const rm = removeCodexGraphMcp();
  let hookDetail = "hooks skipped";
  try {
    const hooks = upsertCodexTokenomyHooks(hookBinaryPath(), backup);
    hookDetail = `hooks ${hooks.hooksPath}`;
  } catch {
    hookDetail = "hooks failed";
  }
  return {
    agent: "codex",
    installed: hookDetail !== "hooks failed",
    detail:
      rm.status === 0
        ? `codex mcp tokenomy-graph removed; graph MCP skipped; ${hookDetail}`
        : `graph MCP skipped; ${hookDetail}`,
  };
};

const codexUninstall = (backup: boolean): AgentInstallResult => {
  if (!commandExists("codex")) return { agent: "codex", installed: false, detail: "codex not on PATH" };
  const rm = removeCodexGraphMcp();
  let hookDetail = "hooks removed";
  try {
    removeCodexTokenomyHooks(hookBinaryPath(), backup);
  } catch {
    hookDetail = "hooks remove failed";
  }
  return {
    agent: "codex",
    installed: rm.status === 0 && hookDetail !== "hooks remove failed",
    detail:
      rm.status === 0
        ? `codex mcp remove tokenomy-graph; ${hookDetail}`
        : `codex mcp remove failed; ${hookDetail}`,
  };
};

export const AGENT_ADAPTERS: AgentAdapter[] = [
  {
    name: "claude-code",
    configPath: () => homePath(".claude", "settings.json"),
    detect: () => existsSync(homePath(".claude")) || commandExists("claude"),
    install: () => ({ agent: "claude-code", installed: true, detail: "Claude Code hooks handled by tokenomy init" }),
  },
  {
    name: "codex",
    detect: () => existsSync(homePath(".codex")) || commandExists("codex"),
    install: (graphPath, backup) => codexInstall(graphPath, backup),
    uninstall: (backup) => codexUninstall(backup),
  },
  {
    name: "cursor",
    configPath: () => homePath(".cursor", "mcp.json"),
    detect: () => existsSync(homePath(".cursor")),
    install: (graphPath, backup) => patchMcpJson("cursor", homePath(".cursor", "mcp.json"), graphPath, backup),
    uninstall: (backup) => removeMcpJson("cursor", homePath(".cursor", "mcp.json"), backup),
  },
  {
    name: "windsurf",
    configPath: () => homePath(".codeium", "windsurf", "mcp_config.json"),
    detect: () => existsSync(homePath(".codeium", "windsurf")),
    install: (graphPath, backup) =>
      patchMcpJson("windsurf", homePath(".codeium", "windsurf", "mcp_config.json"), graphPath, backup),
    uninstall: (backup) => removeMcpJson("windsurf", homePath(".codeium", "windsurf", "mcp_config.json"), backup),
  },
  {
    name: "cline",
    configPath: () => homePath(".cline", "mcp_settings.json"),
    detect: () => existsSync(homePath(".cline")),
    install: (graphPath, backup) => patchMcpJson("cline", homePath(".cline", "mcp_settings.json"), graphPath, backup),
    uninstall: (backup) => removeMcpJson("cline", homePath(".cline", "mcp_settings.json"), backup),
  },
  {
    name: "gemini",
    configPath: () => homePath(".gemini", "settings.json"),
    detect: () => existsSync(homePath(".gemini")) || commandExists("gemini"),
    install: (graphPath, backup) => patchMcpJson("gemini", homePath(".gemini", "settings.json"), graphPath, backup),
    uninstall: (backup) => removeMcpJson("gemini", homePath(".gemini", "settings.json"), backup),
  },
];

export const agentNames = (): AgentName[] => AGENT_ADAPTERS.map((a) => a.name);

export const findAgent = (name: string): AgentAdapter | undefined =>
  AGENT_ADAPTERS.find((adapter) => adapter.name === name);

export const listAgentDetection = (): { agent: AgentName; detected: boolean; detail: string }[] =>
  AGENT_ADAPTERS.map((adapter) => ({
    agent: adapter.name,
    detected: adapter.detect(),
    detail: adapter.configPath?.() ?? "CLI registration",
  }));

export const installDetectedAgents = (
  graphPath: string,
  backup: boolean,
  requested?: AgentName,
): AgentInstallResult[] => {
  const adapters = requested
    ? AGENT_ADAPTERS.filter((adapter) => adapter.name === requested)
    : AGENT_ADAPTERS.filter((adapter) => adapter.name !== "claude-code" && adapter.detect());
  return adapters.map((adapter) => adapter.install(graphPath, backup));
};

export const uninstallAgent = (agent: AgentName, backup: boolean): AgentInstallResult => {
  const adapter = findAgent(agent);
  if (!adapter?.uninstall) {
    return { agent, installed: false, detail: "no uninstall adapter" };
  }
  return adapter.uninstall(backup);
};
