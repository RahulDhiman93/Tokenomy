import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { once } from "node:events";
import {
  claudeSettingsPath,
  globalConfigPath,
  graphDirtySentinelPath,
  hookBinaryPath,
  manifestPath,
  ravenRootDir,
  tokenomyDir,
  tokenomyGraphRootDir,
  updateCachePath,
} from "../core/paths.js";
import { safeParse } from "../util/json.js";
import {
  countHooksForPath,
  getMcpServer,
  hasOverlappingMcpHook,
  matchersForPath,
} from "../util/settings-patch.js";
import { getClaudeMcpServer } from "../util/claude-user-config.js";
import type { SettingsShape } from "../util/settings-patch.js";
import { DEFAULT_CONFIG } from "../core/config.js";
// `join` used in perf-stats path resolution (see readPerfStats).
import { readManifest } from "../util/manifest.js";
import type { Config } from "../core/types.js";
import { listAgentDetection } from "./agents/index.js";

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
  const prompt = countHooksForPath(settings, hook, "UserPromptSubmit");
  const session = countHooksForPath(settings, hook, "SessionStart");
  const ok = post === 1 && pre === 1 && prompt === 1 && session === 1;
  return {
    name: "Hook entries present (PostToolUse + PreToolUse + UserPromptSubmit + SessionStart)",
    ok,
    detail: `post=${post} pre=${pre} prompt=${prompt} session=${session}`,
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

const preMatcherCoverageCheck = (settings: SettingsShape | undefined): CheckResult => {
  const name = "PreToolUse matcher covers Read + Bash + Write + Edit";
  if (!settings) {
    return { name, ok: true, detail: "no settings" };
  }
  const matchers = matchersForPath(settings, hookBinaryPath(), "PreToolUse");
  if (matchers.length === 0) {
    return {
      name,
      ok: false,
      detail: "no PreToolUse entries for tokenomy-hook",
      remediation: "Run `tokenomy init`.",
    };
  }
  const joined = matchers.join(" | ");
  const coversRead = /(^|\W)Read(\W|$)/.test(joined);
  const coversBash = /(^|\W)Bash(\W|$)/.test(joined);
  const coversWrite = /(^|\W)Write(\W|$)/.test(joined);
  const coversEdit = /(^|\W)Edit(\W|$)/.test(joined);
  const ok = coversRead && coversBash && coversWrite && coversEdit;
  const missing = [
    !coversRead && "Read",
    !coversBash && "Bash",
    !coversWrite && "Write",
    !coversEdit && "Edit",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    name,
    ok,
    detail: ok ? joined : `missing: ${missing}`,
    remediation: ok ? undefined : "Run `tokenomy init` to refresh the matcher.",
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

const graphRegistrationCheck = (settings: SettingsShape | undefined): CheckResult => {
  // Claude Code 2.1+ reads MCP servers from ~/.claude.json. Older installs
  // may still carry an entry in ~/.claude/settings.json.mcpServers — check
  // the new location first, fall back to the legacy spot.
  const fromClaudeJson = getClaudeMcpServer("tokenomy-graph") as
    | { command?: unknown; args?: unknown; type?: unknown }
    | undefined;
  const legacy = settings ? getMcpServer(settings, "tokenomy-graph") : undefined;
  const entry = fromClaudeJson ?? legacy;

  if (!entry) {
    return {
      name: "Graph MCP registration",
      ok: true,
      detail: "not configured",
    };
  }
  const args = Array.isArray(entry.args) ? (entry.args as string[]) : [];
  const ok = entry.command === "tokenomy" && args[0] === "graph" && args[1] === "serve";
  const location = fromClaudeJson ? "~/.claude.json" : "~/.claude/settings.json (legacy)";
  return {
    name: "Graph MCP registration",
    ok,
    detail: ok ? `tokenomy-graph configured in ${location}` : "tokenomy-graph entry is malformed",
    remediation: ok ? undefined : "Re-run `tokenomy init --graph-path=<repo>` to repair it.",
  };
};

const statusLineCheck = (settings: SettingsShape | undefined): CheckResult => {
  const entry = settings?.statusLine as { type?: unknown; command?: unknown } | undefined;
  const ok = entry?.type === "command" && entry.command === "tokenomy status-line";
  return {
    name: "Statusline registered",
    ok,
    detail: ok ? "tokenomy status-line" : "missing",
    remediation: ok ? undefined : "Run `tokenomy init` to register the Claude Code statusline.",
  };
};

const agentDetectionCheck = (): CheckResult => {
  const detected = listAgentDetection().filter((row) => row.detected).map((row) => row.agent);
  return {
    name: "Agent detection",
    ok: true,
    detail: detected.length ? detected.join(", ") : "Claude Code only / no extra agents detected",
  };
};

export interface PerfStats {
  samples: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}

// Read recent hook runs from ~/.tokenomy/debug.jsonl and compute perf stats.
// Returns null if the log is missing or has no timed entries.
export const readPerfStats = (sampleSize: number): PerfStats | null => {
  const path = join(tokenomyDir(), "debug.jsonl");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const recent = lines.slice(-sampleSize * 2); // allow headroom for untimed lines
  const samples: number[] = [];
  for (const line of recent) {
    const parsed = safeParse<{ elapsed_ms?: unknown }>(line);
    const ms = parsed?.elapsed_ms;
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) samples.push(ms);
  }
  const cut = samples.slice(-sampleSize);
  if (cut.length === 0) return null;
  const sorted = [...cut].sort((a, b) => a - b);
  const pick = (pct: number): number => {
    const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(pct * sorted.length)));
    return sorted[i] ?? 0;
  };
  return {
    samples: sorted.length,
    p50_ms: pick(0.5),
    p95_ms: pick(0.95),
    max_ms: sorted[sorted.length - 1] ?? 0,
  };
};

const hookPerfCheck = (cfg: Partial<Config> | undefined): CheckResult => {
  const budget = cfg?.perf?.p95_budget_ms ?? DEFAULT_CONFIG.perf?.p95_budget_ms ?? 50;
  const sampleSize = cfg?.perf?.sample_size ?? DEFAULT_CONFIG.perf?.sample_size ?? 100;
  const stats = readPerfStats(sampleSize);
  if (!stats) {
    return {
      name: "Hook perf budget",
      ok: true,
      detail: "no samples yet (run a few Claude Code tool calls first)",
    };
  }
  const ok = stats.p95_ms <= budget;
  return {
    name: "Hook perf budget",
    ok,
    detail: `p50=${stats.p50_ms}ms p95=${stats.p95_ms}ms max=${stats.max_ms}ms (n=${stats.samples}, budget ${budget}ms)`,
    remediation: ok
      ? undefined
      : "p95 above budget. Consider disabling trim profiles for hot tools or raising cfg.perf.p95_budget_ms.",
  };
};

const mcpSdkCheck = async (): Promise<CheckResult> => {
  try {
    await import("@modelcontextprotocol/sdk/server/index.js");
    return {
      name: "Graph MCP SDK available",
      ok: true,
      detail: "@modelcontextprotocol/sdk import ok",
    };
  } catch (error) {
    return {
      name: "Graph MCP SDK available",
      ok: false,
      detail: (error as Error).message,
      remediation: "Install dependencies and rebuild Tokenomy.",
    };
  }
};

export const runDoctor = async (): Promise<CheckResult[]> => {
  const out: CheckResult[] = [];
  out.push(nodeVersionCheck());
  const s = settingsParseCheck();
  out.push(s.result);
  out.push(hookEntryCheck(s.settings));
  out.push(preMatcherCoverageCheck(s.settings));
  out.push(hookBinaryExecCheck());
  out.push(await smokeSpawnCheck());
  out.push(configParseCheck());

  const cfgRaw = existsSync(globalConfigPath())
    ? safeParse<Partial<Config>>(readFileSync(globalConfigPath(), "utf8"))
    : undefined;
  out.push(logDirWritableCheck(cfgRaw));
  out.push(manifestDriftCheck(s.settings));
  out.push(overlapWarnCheck(s.settings));
  out.push(graphRegistrationCheck(s.settings));
  out.push(statusLineCheck(s.settings));
  out.push(agentDetectionCheck());
  out.push(await mcpSdkCheck());
  out.push(hookPerfCheck(cfgRaw));
  // 0.1.5+ additions
  out.push(graphDirtyAgeCheck());
  out.push(ravenStoreSizeCheck());
  out.push(savingsLogSizeCheck(cfgRaw));
  out.push(updateCacheAgeCheck());
  return out;
};

// 0.1.5+: warn when the .dirty sentinel has been pending for over an hour
// without a successful rebuild — indicates the read-side async rebuild is
// failing (or no MCP graph tool has fired since the edits).
//
// All four 0.1.5 hardening checks use static imports (the project is ESM;
// `require()` was unavailable at runtime in earlier 0.1.5 drafts — codex
// audit catch).
const graphDirtyAgeCheck = (): CheckResult => {
  try {
    const root = tokenomyGraphRootDir();
    if (!existsSync(root)) {
      return { name: "Graph dirty sentinel age", ok: true, detail: "no graphs registered" };
    }
    let oldestMs = 0;
    let oldestRepo = "";
    for (const repoId of readdirSync(root)) {
      const dirty = graphDirtySentinelPath(repoId);
      if (!existsSync(dirty)) continue;
      try {
        const ageMs = Date.now() - statSync(dirty).mtimeMs;
        if (ageMs > oldestMs) {
          oldestMs = ageMs;
          oldestRepo = repoId;
        }
      } catch {
        // skip
      }
    }
    if (oldestMs === 0) {
      return { name: "Graph dirty sentinel age", ok: true, detail: "no pending sentinel" };
    }
    const oneHour = 60 * 60 * 1000;
    const ok = oldestMs < oneHour;
    return {
      name: "Graph dirty sentinel age",
      ok,
      detail: `oldest .dirty: ${Math.round(oldestMs / 60_000)}min (repo ${oldestRepo.slice(0, 12)}…)`,
      ...(ok
        ? {}
        : {
            remediation:
              "Open Claude Code and call any graph MCP tool (e.g. `find_usages`) to trigger the async rebuild that clears the sentinel. Or run `tokenomy graph build --path \"$PWD\"`.",
          }),
    };
  } catch (e) {
    return { name: "Graph dirty sentinel age", ok: true, detail: `(skipped: ${(e as Error).message})` };
  }
};

const ravenStoreSizeCheck = (): CheckResult => {
  try {
    const root = ravenRootDir();
    if (!existsSync(root)) return { name: "Raven store size", ok: true, detail: "no Raven store" };
    let total = 0;
    const stack: string[] = [root];
    let scanned = 0;
    const CAP = 50_000;
    while (stack.length > 0 && scanned < CAP) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        scanned++;
        if (scanned >= CAP) break;
        const full = join(dir, name);
        try {
          const st = statSync(full);
          if (st.isDirectory()) stack.push(full);
          else total += st.size;
        } catch {
          // skip
        }
      }
    }
    const tenMB = 10 * 1024 * 1024;
    const ok = total < tenMB;
    return {
      name: "Raven store size",
      ok,
      detail: `${(total / 1024 / 1024).toFixed(1)} MB`,
      ...(ok
        ? {}
        : {
            remediation:
              "Run `tokenomy raven clean --keep=20 --older-than=14` to prune old packets/reviews.",
          }),
    };
  } catch (e) {
    return { name: "Raven store size", ok: true, detail: `(skipped: ${(e as Error).message})` };
  }
};

const savingsLogSizeCheck = (cfgRaw: Partial<Config> | undefined): CheckResult => {
  try {
    const logPath = cfgRaw?.log_path ?? join(tokenomyDir(), "savings.jsonl");
    if (!existsSync(logPath)) {
      return { name: "Savings log size", ok: true, detail: "no log yet" };
    }
    const st = statSync(logPath);
    const fiftyMB = 50 * 1024 * 1024;
    const ok = st.size < fiftyMB;
    return {
      name: "Savings log size",
      ok,
      detail: `${(st.size / 1024 / 1024).toFixed(1)} MB`,
      ...(ok
        ? {}
        : {
            remediation:
              `Truncate or rotate ~/.tokenomy/savings.jsonl. Tokenomy's stream-tail readers cap at 1 MB but the file can still bloat.`,
          }),
    };
  } catch (e) {
    return { name: "Savings log size", ok: true, detail: `(skipped: ${(e as Error).message})` };
  }
};

const updateCacheAgeCheck = (): CheckResult => {
  try {
    const path = updateCachePath();
    if (!existsSync(path)) {
      return {
        name: "Update cache age",
        ok: true,
        detail: "no cache yet (will populate on next SessionStart)",
      };
    }
    const st = statSync(path);
    const ageMs = Date.now() - st.mtimeMs;
    const oneDay = 24 * 60 * 60 * 1000;
    const ok = ageMs < oneDay;
    return {
      name: "Update cache age",
      ok,
      detail: `${Math.round(ageMs / 60_000)}min old`,
      ...(ok
        ? {}
        : {
            remediation:
              "Cache is past 24h — `tokenomy update --check` should be running on SessionStart. Run it manually or restart Claude Code.",
          }),
    };
  } catch (e) {
    return { name: "Update cache age", ok: true, detail: `(skipped: ${(e as Error).message})` };
  }
};

// runDoctorFix applies a safe subset of remediations for failing checks.
// Intentionally conservative: we only do actions a user could do by hand
// without surprise.
export const runDoctorFix = async (): Promise<CheckResult[]> => {
  const applied: CheckResult[] = [];
  const checks = await runDoctor();

  for (const c of checks) {
    if (c.ok) continue;

    // Log directory writable → create it.
    if (c.name === "Log directory writable") {
      const cfgRaw = existsSync(globalConfigPath())
        ? safeParse<Partial<Config>>(readFileSync(globalConfigPath(), "utf8"))
        : undefined;
      const p = cfgRaw?.log_path ?? DEFAULT_CONFIG.log_path;
      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dirname(p), { recursive: true });
        applied.push({ name: c.name, ok: true, detail: `created ${dirname(p)}` });
      } catch (e) {
        applied.push({ name: c.name, ok: false, detail: (e as Error).message });
      }
      continue;
    }

    // Hook binary not executable → chmod +x.
    if (c.name === "Hook binary exists + executable") {
      const p = hookBinaryPath();
      if (!existsSync(p)) {
        applied.push({ name: c.name, ok: false, detail: "binary missing; run tokenomy init" });
        continue;
      }
      try {
        const { chmodSync } = await import("node:fs");
        chmodSync(p, 0o755);
        applied.push({ name: c.name, ok: true, detail: `chmod +x ${p}` });
      } catch (e) {
        applied.push({ name: c.name, ok: false, detail: (e as Error).message });
      }
      continue;
    }

    // Hook entries missing / manifest drift → re-run init.
    if (
      c.name === "Hook entries present (PostToolUse + PreToolUse + UserPromptSubmit + SessionStart)" ||
      c.name === "Manifest drift" ||
      c.name === "Statusline registered"
    ) {
      try {
        const { runInit } = await import("./init.js");
        const r = runInit({ backup: true });
        applied.push({ name: c.name, ok: true, detail: `re-patched settings: ${r.settingsPath}` });
      } catch (e) {
        applied.push({ name: c.name, ok: false, detail: (e as Error).message });
      }
      continue;
    }

    // Stale graph → trigger rebuild.
    if (c.name === "Hook perf budget") {
      applied.push({ name: c.name, ok: true, detail: "informational only; no fix" });
      continue;
    }

    // Otherwise: surface the original remediation without auto-applying.
    applied.push({
      name: c.name,
      ok: false,
      detail: c.remediation ?? "no automatic fix available",
    });
  }

  return applied;
};
