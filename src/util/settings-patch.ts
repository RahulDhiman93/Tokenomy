interface HookCommandEntry {
  type?: string;
  command?: string;
  timeout?: number;
  [k: string]: unknown;
}

interface HookMatcherEntry {
  matcher?: string;
  hooks?: HookCommandEntry[];
  [k: string]: unknown;
}

interface McpServerEntry {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  [k: string]: unknown;
}

interface SettingsShape {
  hooks?: {
    PostToolUse?: HookMatcherEntry[];
    PreToolUse?: HookMatcherEntry[];
    UserPromptSubmit?: HookMatcherEntry[];
    SessionStart?: HookMatcherEntry[];
    [event: string]: HookMatcherEntry[] | undefined;
  };
  mcpServers?: Record<string, McpServerEntry>;
  [k: string]: unknown;
}

export type HookEvent =
  | "PostToolUse"
  | "PreToolUse"
  | "UserPromptSubmit"
  | "SessionStart";

const stripQuotes = (s: string): string => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};

const commandMatchesPath = (cmd: string | undefined, targetPath: string): boolean => {
  if (typeof cmd !== "string") return false;
  return stripQuotes(cmd) === targetPath;
};

const cleanEvent = (
  entries: HookMatcherEntry[] | undefined,
  commandPath: string,
): HookMatcherEntry[] | undefined => {
  if (!Array.isArray(entries)) return entries;
  const cleaned: HookMatcherEntry[] = [];
  for (const matcher of entries) {
    const hooks = Array.isArray(matcher.hooks) ? matcher.hooks : [];
    const filtered = hooks.filter((h) => !commandMatchesPath(h.command, commandPath));
    if (filtered.length === 0) continue;
    cleaned.push({ ...matcher, hooks: filtered });
  }
  return cleaned.length ? cleaned : undefined;
};

export const removeHookByCommandPath = (
  settings: SettingsShape,
  commandPath: string,
): SettingsShape => {
  if (!settings.hooks) return settings;
  const newHooks: Record<string, HookMatcherEntry[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const cleaned = cleanEvent(entries, commandPath);
    if (cleaned) newHooks[event] = cleaned;
  }
  const out: SettingsShape = { ...settings };
  if (Object.keys(newHooks).length === 0) delete out.hooks;
  else out.hooks = newHooks;
  return out;
};

export const addHook = (
  settings: SettingsShape,
  event: HookEvent,
  commandPath: string,
  matcher: string,
  timeout: number,
): SettingsShape => {
  const existing = settings.hooks?.[event] ?? [];
  const entry: HookMatcherEntry = {
    matcher,
    hooks: [
      {
        type: "command",
        command: `"${commandPath}"`,
        timeout,
      },
    ],
  };
  return {
    ...settings,
    hooks: {
      ...(settings.hooks ?? {}),
      [event]: [...existing, entry],
    },
  };
};

export const countHooksForPath = (
  settings: SettingsShape,
  commandPath: string,
  event?: HookEvent,
): number => {
  const events = event
    ? [event]
    : (["PostToolUse", "PreToolUse", "UserPromptSubmit", "SessionStart"] as HookEvent[]);
  let n = 0;
  for (const e of events) {
    const entries = settings.hooks?.[e];
    if (!Array.isArray(entries)) continue;
    for (const m of entries) {
      for (const h of m.hooks ?? []) {
        if (commandMatchesPath(h.command, commandPath)) n++;
      }
    }
  }
  return n;
};

// Return the matcher strings attached to our hook command for a given event.
// Used by doctor to verify that the PreToolUse hook covers the tool names we
// expect (e.g. both `Read` and `Bash` after Phase 4).
export const matchersForPath = (
  settings: SettingsShape,
  commandPath: string,
  event: HookEvent,
): string[] => {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const m of entries) {
    for (const h of m.hooks ?? []) {
      if (commandMatchesPath(h.command, commandPath)) {
        out.push(m.matcher ?? "");
      }
    }
  }
  return out;
};

export const hasOverlappingMcpHook = (
  settings: SettingsShape,
  ourCommandPath: string,
): boolean => {
  const posts = settings.hooks?.PostToolUse;
  if (!Array.isArray(posts)) return false;
  for (const m of posts) {
    const matcher = m.matcher ?? "";
    if (!/mcp__/.test(matcher)) continue;
    for (const h of m.hooks ?? []) {
      if (!commandMatchesPath(h.command, ourCommandPath)) return true;
    }
  }
  return false;
};

export const upsertMcpServer = (
  settings: SettingsShape,
  name: string,
  server: McpServerEntry,
): SettingsShape => ({
  ...settings,
  mcpServers: {
    ...(settings.mcpServers ?? {}),
    [name]: server,
  },
});

export const removeMcpServerByName = (
  settings: SettingsShape,
  name: string,
): SettingsShape => {
  if (!settings.mcpServers?.[name]) return settings;
  const nextServers = { ...(settings.mcpServers ?? {}) };
  delete nextServers[name];
  const next: SettingsShape = { ...settings };
  if (Object.keys(nextServers).length === 0) delete next.mcpServers;
  else next.mcpServers = nextServers;
  return next;
};

export const getMcpServer = (
  settings: SettingsShape,
  name: string,
): McpServerEntry | undefined => settings.mcpServers?.[name];

export type { SettingsShape, HookMatcherEntry, HookCommandEntry, McpServerEntry };
