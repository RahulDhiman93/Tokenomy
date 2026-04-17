import { existsSync, readFileSync, rmSync } from "node:fs";
import { claudeSettingsPath, hookBinaryPath, tokenomyDir } from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { backupFile } from "../util/backup.js";
import { safeParse, stableStringify } from "../util/json.js";
import { removeHookByCommandPath } from "../util/settings-patch.js";
import type { SettingsShape } from "../util/settings-patch.js";
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
    const cleaned = removeHookByCommandPath(parsed, hookPath);
    if (JSON.stringify(cleaned) !== JSON.stringify(parsed)) {
      atomicWrite(settingsPath, stableStringify(cleaned) + "\n");
      hooksRemoved = true;
    }
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
