import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
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
import {
  addHook,
  removeHookByCommandPath,
} from "../util/settings-patch.js";
import { upsertClaudeMcpServer } from "../util/claude-user-config.js";
import type { SettingsShape } from "../util/settings-patch.js";
import { readManifest, upsertEntry, writeManifest } from "../util/manifest.js";

export interface InitOptions {
  aggression?: Config["aggression"];
  backup?: boolean;
  graphPath?: string;
}

import { spawnSync } from "node:child_process";

// Shell out to `codex mcp add` when Codex CLI is present. Idempotent:
// re-registers with the same name if one already exists. Best-effort —
// swallows all errors so Claude-Code-only installs never break.
const tryRegisterCodex = (graphServerPath: string): boolean => {
  const which = spawnSync("which", ["codex"], { encoding: "utf8" });
  if (which.status !== 0) return false;
  // Remove first (idempotent), then add. Both may fail silently.
  spawnSync("codex", ["mcp", "remove", "tokenomy-graph"], { stdio: "ignore" });
  const add = spawnSync(
    "codex",
    ["mcp", "add", "tokenomy-graph", "--", "tokenomy", "graph", "serve", "--path", graphServerPath],
    { stdio: "ignore" },
  );
  return add.status === 0;
};

const tryRemoveCodex = (): boolean => {
  const which = spawnSync("which", ["codex"], { encoding: "utf8" });
  if (which.status !== 0) return false;
  const rm = spawnSync("codex", ["mcp", "remove", "tokenomy-graph"], { stdio: "ignore" });
  return rm.status === 0;
};

const POST_MATCHER = "mcp__.*";
// PreToolUse fires for Read (file clamp), Bash (input bounder), and Write
// (OSS-alternatives nudge, alpha.18+). Claude Code matchers accept regex-style
// alternation, so one entry covers all three.
const PRE_MATCHER = "Read|Bash|Write";
const TIMEOUT_SECONDS = 10;
const GRAPH_SERVER_NAME = "tokenomy-graph";

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

  // Tokenomy is authored as ESM ("type":"module" in package.json) but the
  // staged `dist/` lives under `~/.tokenomy/bin/` where Node's module
  // resolution has no package.json to inherit from. Without a marker file
  // here, Node parses the .js files as CommonJS and the first `import`
  // statement throws "Cannot use import statement outside a module".
  // Dropping a minimal `{"type":"module"}` next to the staged dist fixes
  // this regardless of where the user invokes the hook from.
  writeFileSync(
    join(tokenomyBinDir(), "package.json"),
    JSON.stringify({ type: "module", private: true }, null, 2) + "\n",
  );

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
  graphServerPath: string | null;
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
  const graphServerPath = opts.graphPath ? resolve(opts.graphPath) : null;

  atomicWrite(settingsPath, stableStringify(settings) + "\n");

  // Claude Code 2.1+ reads MCP registrations from ~/.claude.json (not
  // ~/.claude/settings.json). Writing to the settings file we just patched
  // wouldn't take effect. Route the MCP upsert through the separate
  // ~/.claude.json surgical patcher.
  if (graphServerPath) {
    upsertClaudeMcpServer(GRAPH_SERVER_NAME, {
      command: "tokenomy",
      args: ["graph", "serve", "--path", graphServerPath],
    });
    // Best-effort Codex registration: Codex CLI writes to its own
    // ~/.codex/config.toml. Shell out to `codex mcp add` if the binary is
    // on PATH. Non-fatal: init succeeds for Claude-Code-only installs.
    tryRegisterCodex(graphServerPath);
  }

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
    graphServerPath,
  };
};
