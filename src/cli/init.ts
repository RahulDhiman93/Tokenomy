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
  upsertStatusLine,
} from "../util/settings-patch.js";
import { upsertClaudeMcpServer } from "../util/claude-user-config.js";
import type { SettingsShape } from "../util/settings-patch.js";
import { readManifest, upsertEntry, writeManifest } from "../util/manifest.js";
import { installDetectedAgents } from "./agents/index.js";
import type { AgentInstallResult, AgentName } from "./agents/common.js";

export interface InitOptions {
  aggression?: Config["aggression"];
  backup?: boolean;
  graphPath?: string;
  agent?: AgentName;
}

// 0.1.3+: PostToolUse covers MCP (response trim) + Bash (stacktrace
// compress) AND now Edit/Write/MultiEdit/NotebookEdit so the
// graph-dirty sentinel fires whenever the agent mutates a tracked file.
// Per-edit cost: one stat + one small file append (~50 B). Net win
// because `isGraphStaleCheap` short-circuits to "stale" without
// walking the repo.
const POST_MATCHER = "mcp__.*|Bash|Edit|Write|MultiEdit|NotebookEdit";
// PreToolUse fires for Read (file clamp), Bash (input bounder), and Write
// (OSS-alternatives nudge, alpha.18+). Claude Code matchers accept regex-style
// alternation, so one entry covers all three.
const PRE_MATCHER = "Read|Bash|Write|Edit";
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
  hookPath: string | null;
  settingsPath: string | null;
  configPath: string;
  manifestPath: string;
  graphServerPath: string | null;
  agentResults: AgentInstallResult[];
} => {
  const installClaude = !opts.agent || opts.agent === "claude-code";
  const needsHookBinary = installClaude || opts.agent === "codex";
  const hookPath = needsHookBinary ? stageHookBinary() : null;
  const settingsPath = claudeSettingsPath();

  let backupPath: string | null = null;

  if (installClaude && hookPath) {
    backupPath = opts.backup === false ? null : backupFile(settingsPath);

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
    // UserPromptSubmit fires once per user turn, before the model sees the
    // prompt. Matcher is empty because the event isn't tool-scoped. Powers
    // the prompt-classifier nudge (alpha.22+) and the Golem per-turn
    // reinforcement (0.1.1-beta.1+).
    settings = addHook(settings, "UserPromptSubmit", hookPath, "", TIMEOUT_SECONDS);
    // SessionStart fires once when a new coding session begins. Powers the
    // Golem output-mode preamble (0.1.1-beta.1+). Passthrough when Golem
    // is disabled — the hook returns null and nothing is injected.
    settings = addHook(settings, "SessionStart", hookPath, "", TIMEOUT_SECONDS);
    settings = upsertStatusLine(settings, "tokenomy status-line");

    // 0.1.7+: rollback on failure. Pre-0.1.7 a throw between backup and
    // any subsequent step left the user with broken hooks and no clear
    // path to recover. Now we restore the backup on any settings/MCP/
    // manifest write failure inside this block.
    try {
      atomicWrite(settingsPath, stableStringify(settings) + "\n");
    } catch (e) {
      if (backupPath && existsSync(backupPath)) {
        try {
          const restored = readFileSync(backupPath);
          atomicWrite(settingsPath, restored.toString("utf8"));
        } catch {
          // best-effort
        }
      }
      throw e;
    }
  }

  // Codex installs are hooks-only (0.1.7+) — never report graphServerPath
  // or trigger the post-init graph build, even when the user passes
  // --graph-path explicitly. The agent install path still uses the cwd
  // so the codex install branch sees a valid working dir.
  const isCodexOnly = opts.agent === "codex";
  const graphServerPath = isCodexOnly
    ? null
    : opts.graphPath
      ? resolve(opts.graphPath)
      : opts.agent && opts.agent !== "claude-code"
        ? resolve(process.cwd())
        : null;
  const agentInstallPath =
    graphServerPath ?? (isCodexOnly ? resolve(opts.graphPath ?? process.cwd()) : null);

  // Claude Code 2.1+ reads MCP registrations from ~/.claude.json (not
  // ~/.claude/settings.json). Writing to the settings file we just patched
  // wouldn't take effect. Route the MCP upsert through the separate
  // ~/.claude.json surgical patcher.
  if (graphServerPath) {
    if (installClaude) {
      upsertClaudeMcpServer(GRAPH_SERVER_NAME, {
        command: "tokenomy",
        args: ["graph", "serve", "--path", graphServerPath],
      });
    }
  }

  const agentResults = agentInstallPath
    ? installDetectedAgents(agentInstallPath, opts.backup !== false, opts.agent)
    : [];

  if (hookPath && installClaude) {
    let manifest = readManifest();
    manifest = upsertEntry(manifest, {
      command_path: hookPath,
      settings_path: settingsPath,
      matcher: `PostToolUse:${POST_MATCHER}|PreToolUse:${PRE_MATCHER}|UserPromptSubmit|SessionStart`,
      installed_at: new Date().toISOString(),
    });
    writeManifest(manifest);
  }

  const configPath = writeDefaultConfigIfMissing(opts);

  return {
    backupPath,
    hookPath,
    settingsPath: installClaude ? settingsPath : null,
    configPath,
    manifestPath: manifestPath(),
    graphServerPath,
    agentResults,
  };
};
