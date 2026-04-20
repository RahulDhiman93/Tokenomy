import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const expandHome = (p: string): string =>
  p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^\/+/, "")) : p;

export const tokenomyDir = (): string => join(homedir(), ".tokenomy");
export const tokenomyBinDir = (): string => join(tokenomyDir(), "bin");
export const tokenomyGraphRootDir = (): string => join(tokenomyDir(), "graphs");
export const hookBinaryPath = (): string => join(tokenomyBinDir(), "tokenomy-hook");
export const globalConfigPath = (): string => join(tokenomyDir(), "config.json");
export const manifestPath = (): string => join(tokenomyDir(), "installed.json");
export const defaultLogPath = (): string => join(tokenomyDir(), "savings.jsonl");
export const graphDir = (repoId: string): string => join(tokenomyGraphRootDir(), repoId);
export const graphSnapshotPath = (repoId: string): string =>
  join(graphDir(repoId), "snapshot.json");
export const graphMetaPath = (repoId: string): string =>
  join(graphDir(repoId), "meta.json");
export const graphBuildLogPath = (repoId: string): string =>
  join(graphDir(repoId), "build.jsonl");
export const graphLockPath = (repoId: string): string =>
  join(graphDir(repoId), ".build.lock");

export const claudeSettingsPath = (): string =>
  join(homedir(), ".claude", "settings.json");

// Claude Code 2.1+ stores MCP server registrations in ~/.claude.json
// (separate from settings.json, which only holds hooks, effortLevel,
// permissions, etc.). We write/remove our tokenomy-graph entry here so
// `claude mcp list` picks it up without the user needing to run
// `claude mcp add` manually.
export const claudeUserConfigPath = (): string =>
  join(homedir(), ".claude.json");

export const projectConfigPath = (cwd: string): string =>
  resolve(cwd, ".tokenomy.json");
