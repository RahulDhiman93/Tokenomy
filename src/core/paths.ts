import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const expandHome = (p: string): string =>
  p.startsWith("~") ? join(homedir(), p.slice(1).replace(/^\/+/, "")) : p;

export const tokenomyDir = (): string => join(homedir(), ".tokenomy");
export const tokenomyBinDir = (): string => join(tokenomyDir(), "bin");
export const hookBinaryPath = (): string => join(tokenomyBinDir(), "tokenomy-hook");
export const globalConfigPath = (): string => join(tokenomyDir(), "config.json");
export const manifestPath = (): string => join(tokenomyDir(), "installed.json");
export const defaultLogPath = (): string => join(tokenomyDir(), "savings.jsonl");

export const claudeSettingsPath = (): string =>
  join(homedir(), ".claude", "settings.json");

export const projectConfigPath = (cwd: string): string =>
  resolve(cwd, ".tokenomy.json");
