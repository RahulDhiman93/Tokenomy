import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentAdapter, AgentInstallResult, AgentName } from "./common.js";
import { commandExists, homePath, patchMcpJson, removeMcpJson } from "./common.js";

const codexInstall = (graphPath: string): AgentInstallResult => {
  if (!commandExists("codex")) {
    return { agent: "codex", installed: false, detail: "codex not on PATH" };
  }
  spawnSync("codex", ["mcp", "remove", "tokenomy-graph"], { stdio: "ignore" });
  const add = spawnSync(
    "codex",
    ["mcp", "add", "tokenomy-graph", "--", "tokenomy", "graph", "serve", "--path", graphPath],
    { stdio: "ignore" },
  );
  return {
    agent: "codex",
    installed: add.status === 0,
    detail: add.status === 0 ? "codex mcp add tokenomy-graph" : "codex mcp add failed",
  };
};

const codexUninstall = (): AgentInstallResult => {
  if (!commandExists("codex")) return { agent: "codex", installed: false, detail: "codex not on PATH" };
  const rm = spawnSync("codex", ["mcp", "remove", "tokenomy-graph"], { stdio: "ignore" });
  return {
    agent: "codex",
    installed: rm.status === 0,
    detail: rm.status === 0 ? "codex mcp remove tokenomy-graph" : "codex mcp remove failed",
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
    install: (graphPath) => codexInstall(graphPath),
    uninstall: () => codexUninstall(),
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
