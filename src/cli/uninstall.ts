import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { claudeSettingsPath, hookBinaryPath, tokenomyDir } from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { backupFile } from "../util/backup.js";
import { safeParse, stableStringify } from "../util/json.js";
import { removeHookByCommandPath, removeMcpServerByName } from "../util/settings-patch.js";
import type { SettingsShape } from "../util/settings-patch.js";
import { removeClaudeMcpServer } from "../util/claude-user-config.js";
import { deleteManifestFile, readManifest, writeManifest, removeEntryByCommand } from "../util/manifest.js";

export interface UninstallOptions {
  purge?: boolean;
  backup?: boolean;
}

export const runUninstall = (opts: UninstallOptions = {}): {
  backupPath: string | null;
  hooksRemoved: boolean;
  purged: boolean;
} => {
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
  try {
    const which = spawnSync("which", ["codex"], { encoding: "utf8" });
    if (which.status === 0) {
      spawnSync("codex", ["mcp", "remove", "tokenomy-graph"], { stdio: "ignore" });
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
