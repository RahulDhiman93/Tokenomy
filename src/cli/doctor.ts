import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { once } from "node:events";
import {
  claudeSettingsPath,
  globalConfigPath,
  hookBinaryPath,
  manifestPath,
} from "../core/paths.js";
import { safeParse } from "../util/json.js";
import {
  countHooksForPath,
  hasOverlappingMcpHook,
} from "../util/settings-patch.js";
import type { SettingsShape } from "../util/settings-patch.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { readManifest } from "../util/manifest.js";
import type { Config } from "../core/types.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  remediation?: string;
}

const nodeVersionCheck = (): CheckResult => {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "Node >= 20",
    ok: major >= 20,
    detail: `running ${process.versions.node}`,
    remediation: major >= 20 ? undefined : "Upgrade Node to 20+ (nvm install 20).",
  };
};

const settingsParseCheck = (): { result: CheckResult; settings?: SettingsShape } => {
  const p = claudeSettingsPath();
  if (!existsSync(p)) {
    return {
      result: {
        name: "~/.claude/settings.json parses",
        ok: false,
        detail: "file does not exist",
        remediation: "Run `tokenomy init` to create it.",
      },
    };
  }
  const raw = readFileSync(p, "utf8");
  const settings = safeParse<SettingsShape>(raw);
  if (!settings) {
    return {
      result: {
        name: "~/.claude/settings.json parses",
        ok: false,
        detail: "invalid JSON",
        remediation: "Fix the JSON in ~/.claude/settings.json.",
      },
    };
  }
  return { result: { name: "~/.claude/settings.json parses", ok: true, detail: p }, settings };
};

const hookEntryCheck = (settings: SettingsShape | undefined): CheckResult => {
  if (!settings) return { name: "Hook entries present", ok: false, detail: "no settings" };
  const hook = hookBinaryPath();
  const post = countHooksForPath(settings, hook, "PostToolUse");
  const pre = countHooksForPath(settings, hook, "PreToolUse");
  const ok = post === 1 && pre === 1;
  return {
    name: "Hook entries present (PostToolUse + PreToolUse)",
    ok,
    detail: `post=${post} pre=${pre}`,
    remediation: ok ? undefined : "Run `tokenomy init` to install/repair.",
  };
};

const hookBinaryExecCheck = (): CheckResult => {
  const p = hookBinaryPath();
  if (!existsSync(p)) {
    return {
      name: "Hook binary exists + executable",
      ok: false,
      detail: p,
      remediation: "Run `tokenomy init`.",
    };
  }
  try {
    accessSync(p, constants.X_OK);
    return { name: "Hook binary exists + executable", ok: true, detail: p };
  } catch {
    return {
      name: "Hook binary exists + executable",
      ok: false,
      detail: `${p} not executable`,
      remediation: `chmod +x ${p}`,
    };
  }
};

const smokeSpawnCheck = async (): Promise<CheckResult> => {
  const p = hookBinaryPath();
  if (!existsSync(p)) {
    return { name: "Smoke spawn hook (empty mcp call)", ok: false, detail: "binary missing" };
  }
  const sample = {
    session_id: "doctor",
    transcript_path: "/tmp/tokenomy-doctor",
    cwd: process.cwd(),
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "mcp__tokenomy_doctor__noop",
    tool_input: {},
    tool_use_id: "doctor",
    tool_response: { content: [{ type: "text", text: "x" }] },
  };
  const start = Date.now();
  const child = spawn(p, [], { stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  child.stdin.end(JSON.stringify(sample));
  const chunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => chunks.push(c));
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);
  const elapsed = Date.now() - start;
  const stdoutLen = Buffer.concat(chunks).length;
  return {
    name: "Smoke spawn hook (empty mcp call)",
    ok: code === 0 && elapsed < 800 && stdoutLen === 0,
    detail: `exit=${code} elapsed=${elapsed}ms stdoutBytes=${stdoutLen}`,
    remediation: code === 0 ? undefined : "Inspect the hook binary; try running it manually with a sample stdin.",
  };
};

const configParseCheck = (): CheckResult => {
  const p = globalConfigPath();
  if (!existsSync(p)) {
    return {
      name: "~/.tokenomy/config.json parses",
      ok: false,
      detail: "missing",
      remediation: "Run `tokenomy init`.",
    };
  }
  const cfg = safeParse<Partial<Config>>(readFileSync(p, "utf8"));
  if (!cfg) {
    return {
      name: "~/.tokenomy/config.json parses",
      ok: false,
      detail: "invalid JSON",
      remediation: "Fix config JSON or delete it and re-run `tokenomy init`.",
    };
  }
  const known = new Set(Object.keys(DEFAULT_CONFIG));
  const unknown = Object.keys(cfg).filter((k) => !known.has(k));
  return {
    name: "~/.tokenomy/config.json parses",
    ok: true,
    detail: unknown.length ? `ok (unknown keys: ${unknown.join(", ")})` : "ok",
  };
};

const logDirWritableCheck = (cfg: Partial<Config> | undefined): CheckResult => {
  const logPath = cfg?.log_path ?? DEFAULT_CONFIG.log_path;
  const dir = dirname(logPath);
  try {
    accessSync(dir, constants.W_OK);
    return { name: "Log directory writable", ok: true, detail: dir };
  } catch {
    return {
      name: "Log directory writable",
      ok: false,
      detail: dir,
      remediation: `mkdir -p ${dir} && chmod u+w ${dir}`,
    };
  }
};

const manifestDriftCheck = (settings: SettingsShape | undefined): CheckResult => {
  const mp = manifestPath();
  if (!existsSync(mp)) return { name: "Manifest drift", ok: true, detail: "no manifest (ok)" };
  const manifest = readManifest();
  if (!settings) {
    return { name: "Manifest drift", ok: manifest.entries.length === 0, detail: `${manifest.entries.length} entries, no settings` };
  }
  const drifted: string[] = [];
  for (const e of manifest.entries) {
    const n = countHooksForPath(settings, e.command_path);
    if (n === 0) drifted.push(e.command_path);
  }
  return {
    name: "Manifest drift",
    ok: drifted.length === 0,
    detail: drifted.length === 0 ? "clean" : `${drifted.length} stale entry/entries`,
    remediation: drifted.length ? "Run `tokenomy init` to repair." : undefined,
  };
};

const overlapWarnCheck = (settings: SettingsShape | undefined): CheckResult => {
  if (!settings) return { name: "No overlapping mcp__ hook", ok: true, detail: "no settings" };
  const overlap = hasOverlappingMcpHook(settings, hookBinaryPath());
  return {
    name: "No overlapping mcp__ hook",
    ok: !overlap,
    detail: overlap ? "another PostToolUse hook matches mcp__" : "clean",
    remediation: overlap
      ? "Disable other trimmers on mcp__ or expect parallel, indeterminate output."
      : undefined,
  };
};

export const runDoctor = async (): Promise<CheckResult[]> => {
  const out: CheckResult[] = [];
  out.push(nodeVersionCheck());
  const s = settingsParseCheck();
  out.push(s.result);
  out.push(hookEntryCheck(s.settings));
  out.push(hookBinaryExecCheck());
  out.push(await smokeSpawnCheck());
  out.push(configParseCheck());

  const cfgRaw = existsSync(globalConfigPath())
    ? safeParse<Partial<Config>>(readFileSync(globalConfigPath(), "utf8"))
    : undefined;
  out.push(logDirWritableCheck(cfgRaw));
  out.push(manifestDriftCheck(s.settings));
  out.push(overlapWarnCheck(s.settings));
  return out;
};
