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

interface SettingsShape {
  hooks?: {
    PostToolUse?: HookMatcherEntry[];
    PreToolUse?: HookMatcherEntry[];
    [event: string]: HookMatcherEntry[] | undefined;
  };
  [k: string]: unknown;
}

export type HookEvent = "PostToolUse" | "PreToolUse";

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
  const events = event ? [event] : (["PostToolUse", "PreToolUse"] as HookEvent[]);
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

export type { SettingsShape, HookMatcherEntry, HookCommandEntry };
