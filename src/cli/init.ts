import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../core/types.js";
import {
  claudeSettingsPath,
  globalConfigPath,
  hookBinaryPath,
  manifestPath,
  tokenomyBinDir,
  tokenomyDir,
} from "../core/paths.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { atomicWrite } from "../util/atomic.js";
import { backupFile } from "../util/backup.js";
import { safeParse, stableStringify } from "../util/json.js";
import { addHook, removeHookByCommandPath } from "../util/settings-patch.js";
import type { SettingsShape } from "../util/settings-patch.js";
import { readManifest, upsertEntry, writeManifest } from "../util/manifest.js";

export interface InitOptions {
  aggression?: Config["aggression"];
  backup?: boolean;
}

const POST_MATCHER = "mcp__.*";
const PRE_MATCHER = "Read";
const TIMEOUT_SECONDS = 10;

const stageHookBinary = (): string => {
  mkdirSync(tokenomyBinDir(), { recursive: true });

  const here = fileURLToPath(import.meta.url);
  const pkgRoot = here.replace(/\/(src|dist)\/cli\/init\.(ts|js)$/, "");
  const distSrc = `${pkgRoot}/dist`;
  if (!existsSync(`${distSrc}/hook/entry.js`)) {
    throw new Error(
      `Built hook not found at ${distSrc}/hook/entry.js. Did you run 'npm run build'?`,
    );
  }

  const stagedDist = join(tokenomyBinDir(), "dist");
  rmSync(stagedDist, { recursive: true, force: true });
  cpSync(distSrc, stagedDist, { recursive: true });
  chmodSync(join(stagedDist, "hook", "entry.js"), 0o755);

  const wrapper = `#!/bin/sh
exec /usr/bin/env node "$(dirname "$0")/dist/hook/entry.js" "$@"
`;
  writeFileSync(hookBinaryPath(), wrapper);
  chmodSync(hookBinaryPath(), 0o755);

  return hookBinaryPath();
};

const writeDefaultConfigIfMissing = (opts: InitOptions): string => {
  mkdirSync(tokenomyDir(), { recursive: true });
  const p = globalConfigPath();
  if (existsSync(p)) {
    if (opts.aggression) {
      const raw = safeParse<Partial<Config>>(readFileSync(p, "utf8")) ?? {};
      raw.aggression = opts.aggression;
      atomicWrite(p, stableStringify(raw) + "\n", false);
    }
    return p;
  }
  const cfg: Config = { ...DEFAULT_CONFIG };
  if (opts.aggression) cfg.aggression = opts.aggression;
  atomicWrite(p, stableStringify(cfg) + "\n", false);
  return p;
};

export const runInit = (opts: InitOptions = {}): {
  backupPath: string | null;
  hookPath: string;
  settingsPath: string;
  configPath: string;
  manifestPath: string;
} => {
  const hookPath = stageHookBinary();
  const settingsPath = claudeSettingsPath();

  const backupPath = opts.backup === false ? null : backupFile(settingsPath);

  let settings: SettingsShape = {};
  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, "utf8");
    const parsed = safeParse<SettingsShape>(raw);
    if (!parsed) {
      throw new Error(
        `Could not parse ${settingsPath}. Restore from backup at ${backupPath ?? "<none>"} and try again.`,
      );
    }
    settings = parsed;
  }

  settings = removeHookByCommandPath(settings, hookPath);
  settings = addHook(settings, "PostToolUse", hookPath, POST_MATCHER, TIMEOUT_SECONDS);
  settings = addHook(settings, "PreToolUse", hookPath, PRE_MATCHER, TIMEOUT_SECONDS);

  atomicWrite(settingsPath, stableStringify(settings) + "\n");

  let manifest = readManifest();
  manifest = upsertEntry(manifest, {
    command_path: hookPath,
    settings_path: settingsPath,
    matcher: `PostToolUse:${POST_MATCHER}|PreToolUse:${PRE_MATCHER}`,
    installed_at: new Date().toISOString(),
  });
  writeManifest(manifest);

  const configPath = writeDefaultConfigIfMissing(opts);

  return {
    backupPath,
    hookPath,
    settingsPath,
    configPath,
    manifestPath: manifestPath(),
  };
};
