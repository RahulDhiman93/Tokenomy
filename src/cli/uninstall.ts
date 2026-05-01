import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeSettingsPath, hookBinaryPath, tokenomyDir } from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { backupFile } from "../util/backup.js";
import { safeParse, stableStringify } from "../util/json.js";
import { removeHookByCommandPath, removeMcpServerByName } from "../util/settings-patch.js";
import type { SettingsShape } from "../util/settings-patch.js";
import { removeClaudeMcpServer } from "../util/claude-user-config.js";
import { deleteManifestFile, readManifest, writeManifest, removeEntryByCommand } from "../util/manifest.js";
import { uninstallAgent } from "./agents/index.js";
import type { AgentInstallResult, AgentName } from "./agents/common.js";

const CODEX_MCP_REMOVE_TIMEOUT_MS = 2_000;

export interface UninstallOptions {
  purge?: boolean;
  backup?: boolean;
  agent?: AgentName;
}

export const runUninstall = (opts: UninstallOptions = {}): {
  backupPath: string | null;
  hooksRemoved: boolean;
  purged: boolean;
  agentResult?: AgentInstallResult;
} => {
  if (opts.agent && opts.agent !== "claude-code") {
    const agentResult = uninstallAgent(opts.agent, opts.backup !== false);
    return { backupPath: agentResult.backupPath ?? null, hooksRemoved: agentResult.installed, purged: false, agentResult };
  }

  const hookPath = hookBinaryPath();
  const settingsPath = claudeSettingsPath();
  let backupPath: string | null = null;
  let hooksRemoved = false;

  if (existsSync(settingsPath)) {
    backupPath = opts.backup === false ? null : backupFile(settingsPath);
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = safeParse<SettingsShape>(raw);
    if (!parsed) {
      throw new Error(
        `Could not parse ${settingsPath}. Manual cleanup required; backup at ${backupPath ?? "<none>"}`,
      );
    }
    let cleaned = removeHookByCommandPath(parsed, hookPath);
    // Older installs may have written mcpServers into settings.json too
    // (pre-2.1 Claude Code layout). Keep removing it for backward-compat.
    cleaned = removeMcpServerByName(cleaned, "tokenomy-graph");
    if (JSON.stringify(cleaned) !== JSON.stringify(parsed)) {
      atomicWrite(settingsPath, stableStringify(cleaned) + "\n");
      hooksRemoved = true;
    }
  }

  // New-layout MCP registration lives in ~/.claude.json; scrub that too.
  try {
    removeClaudeMcpServer("tokenomy-graph");
  } catch {
    // best-effort: never break uninstall on a failed MCP scrub
  }

  // Codex CLI registration (if present): remove via its own tool.
  // 0.1.7+: surgical fallback if the CLI times out / exits non-zero so
  // an older `[mcp_servers.tokenomy-graph]` entry still gets cleaned.
  try {
    const probeCmd = process.platform === "win32" ? "where" : "which";
    const which = spawnSync(probeCmd, ["codex"], { encoding: "utf8", timeout: 1_000 });
    if (which.status === 0) {
      const r = spawnSync("codex", ["mcp", "remove", "tokenomy-graph"], {
        stdio: "ignore",
        timeout: CODEX_MCP_REMOVE_TIMEOUT_MS,
      });
      if (r.status !== 0) {
        try {
          const cfgPath = join(homedir(), ".codex", "config.toml");
          if (existsSync(cfgPath)) {
            const before = readFileSync(cfgPath, "utf8");
            // Skip when the config has TOML multi-line strings — regex is
            // not TOML-aware (codex round 2).
            if (!before.includes('"""') && !before.includes("'''")) {
              const re = /^\[mcp_servers\.tokenomy-graph\][^\n]*\n(?:(?!^\[)[^\n]*\n?)*/m;
              if (re.test(before)) writeFileSync(cfgPath, before.replace(re, ""));
            }
          }
        } catch {
          // best-effort
        }
      }
    }
  } catch {
    // best-effort
  }

  let manifest = readManifest();
  manifest = removeEntryByCommand(manifest, hookPath);
  if (manifest.entries.length === 0) {
    deleteManifestFile();
  } else {
    writeManifest(manifest);
  }

  let purged = false;
  if (opts.purge) {
    try {
      rmSync(tokenomyDir(), { recursive: true, force: true });
      purged = true;
    } catch {
      // ignore
    }
  }

  return { backupPath, hooksRemoved, purged };
};
