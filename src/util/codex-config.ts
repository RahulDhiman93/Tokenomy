import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite } from "./atomic.js";
import { backupFile } from "./backup.js";
import { safeParse, stableStringify } from "./json.js";

export const codexConfigPath = (): string => join(homedir(), ".codex", "config.toml");
export const codexHooksPath = (): string => join(homedir(), ".codex", "hooks.json");

interface CodexHookCommand {
  type: "command";
  command: string;
  timeout?: number;
  statusMessage?: string;
  [k: string]: unknown;
}

interface CodexHookMatcher {
  matcher?: string;
  hooks?: CodexHookCommand[];
  [k: string]: unknown;
}

interface CodexHooksShape {
  hooks?: Record<string, CodexHookMatcher[]>;
  [k: string]: unknown;
}

export interface CodexHookPatchResult {
  hooksPath: string;
  configPath: string;
  backupPath: string | null;
}

const TOKENOMY_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);

const withoutCommand = (settings: CodexHooksShape, command: string): CodexHooksShape => {
  const hooks = settings.hooks ?? {};
  const nextHooks: Record<string, CodexHookMatcher[]> = {};

  for (const [event, entries] of Object.entries(hooks)) {
    const nextEntries: CodexHookMatcher[] = [];
    for (const entry of entries) {
      const kept = (entry.hooks ?? []).filter((hook) => hook.command !== command);
      if (kept.length > 0) nextEntries.push({ ...entry, hooks: kept });
    }
    if (nextEntries.length > 0) nextHooks[event] = nextEntries;
  }

  return { ...settings, hooks: nextHooks };
};

const addCommandHook = (
  settings: CodexHooksShape,
  event: "SessionStart" | "UserPromptSubmit",
  matcher: string | undefined,
  command: string,
  statusMessage: string,
): CodexHooksShape => {
  const hooks = settings.hooks ?? {};
  const entry: CodexHookMatcher = {
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command, timeout: 10, statusMessage }],
  };
  return {
    ...settings,
    hooks: {
      ...hooks,
      [event]: [...(hooks[event] ?? []), entry],
    },
  };
};

export const enableCodexHooksFeature = (path = codexConfigPath()): void => {
  mkdirSync(dirname(path), { recursive: true });
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = raw.length > 0 ? raw.split(/\r?\n/) : [];
  let featuresStart = -1;
  let featuresEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? "";
    if (/^\[features\]\s*$/.test(trimmed)) {
      featuresStart = i;
      continue;
    }
    if (featuresStart !== -1 && i > featuresStart && /^\[.+\]\s*$/.test(trimmed)) {
      featuresEnd = i;
      break;
    }
  }

  if (featuresStart === -1) {
    const prefix = raw.trim().length > 0 ? `${raw.replace(/\s*$/, "\n\n")}` : "";
    atomicWrite(path, `${prefix}[features]\ncodex_hooks = true\n`, false);
    return;
  }

  let replaced = false;
  for (let i = featuresStart + 1; i < featuresEnd; i++) {
    if (/^\s*codex_hooks\s*=/.test(lines[i] ?? "")) {
      lines[i] = "codex_hooks = true";
      replaced = true;
      break;
    }
  }
  if (!replaced) lines.splice(featuresStart + 1, 0, "codex_hooks = true");
  atomicWrite(path, `${lines.join("\n").replace(/\s*$/, "")}\n`, false);
};

export const upsertCodexTokenomyHooks = (
  command: string,
  backup: boolean,
  path = codexHooksPath(),
  configPath = codexConfigPath(),
): CodexHookPatchResult => {
  mkdirSync(dirname(path), { recursive: true });
  const before = existsSync(path) ? safeParse<CodexHooksShape>(readFileSync(path, "utf8")) : {};
  if (!before) throw new Error(`Could not parse ${path}. Fix the JSON and try again.`);
  const backupPath = backup && existsSync(path) ? backupFile(path) : null;

  let next = withoutCommand(before, command);
  next = addCommandHook(
    next,
    "SessionStart",
    "startup|resume",
    command,
    "Loading Tokenomy session context",
  );
  next = addCommandHook(
    next,
    "UserPromptSubmit",
    undefined,
    command,
    "Checking Tokenomy prompt nudges",
  );

  enableCodexHooksFeature(configPath);
  atomicWrite(path, stableStringify(next) + "\n", false);
  return { hooksPath: path, configPath, backupPath };
};

export const removeCodexTokenomyHooks = (
  command: string,
  backup: boolean,
  path = codexHooksPath(),
  configPath = codexConfigPath(),
): CodexHookPatchResult => {
  if (!existsSync(path)) {
    return { hooksPath: path, configPath, backupPath: null };
  }
  const before = safeParse<CodexHooksShape>(readFileSync(path, "utf8"));
  if (!before) throw new Error(`Could not parse ${path}. Manual cleanup required.`);
  const backupPath = backup ? backupFile(path) : null;
  const next = withoutCommand(before, command);
  if (next.hooks) {
    for (const event of TOKENOMY_EVENTS) {
      if ((next.hooks[event] ?? []).length === 0) delete next.hooks[event];
    }
    if (Object.keys(next.hooks).length === 0) delete next.hooks;
  }
  atomicWrite(path, stableStringify(next) + "\n", false);
  return { hooksPath: path, configPath, backupPath };
};
