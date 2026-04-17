import { readFileSync, existsSync } from "node:fs";
import type { Config } from "./types.js";
import { globalConfigPath, projectConfigPath, defaultLogPath, expandHome } from "./paths.js";

export const DEFAULT_CONFIG: Config = {
  aggression: "conservative",
  gate: {
    always_trim_above_bytes: 40_000,
    min_saved_bytes: 4_000,
    min_saved_pct: 0.25,
  },
  mcp: {
    max_text_bytes: 16_000,
    per_block_head: 4_000,
    per_block_tail: 2_000,
  },
  read: {
    enabled: true,
    clamp_above_bytes: 40_000,
    injected_limit: 500,
  },
  log_path: defaultLogPath(),
  disabled_tools: [],
};

const AGGRESSION_MULT: Record<Config["aggression"], number> = {
  conservative: 2,
  balanced: 1,
  aggressive: 0.5,
};

const readJsonIfExists = (path: string): unknown => {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const deepMerge = (
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const baseVal = out[k];
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal)
    ) {
      out[k] = deepMerge(
        baseVal as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
};

const applyAggression = (cfg: Config): Config => {
  const m = AGGRESSION_MULT[cfg.aggression] ?? 1;
  if (m === 1) return cfg;
  return {
    ...cfg,
    gate: {
      always_trim_above_bytes: Math.round(cfg.gate.always_trim_above_bytes * m),
      min_saved_bytes: Math.round(cfg.gate.min_saved_bytes * m),
      min_saved_pct: cfg.gate.min_saved_pct,
    },
    mcp: {
      max_text_bytes: Math.round(cfg.mcp.max_text_bytes * m),
      per_block_head: Math.round(cfg.mcp.per_block_head * m),
      per_block_tail: Math.round(cfg.mcp.per_block_tail * m),
    },
    read: {
      enabled: cfg.read.enabled,
      // Both scale with m: conservative (×2) is less aggressive (higher threshold,
      // larger injected limit). Aggressive (×0.5) is stricter on both.
      clamp_above_bytes: Math.round(cfg.read.clamp_above_bytes * m),
      injected_limit: Math.max(50, Math.round(cfg.read.injected_limit * m)),
    },
  };
};

export const loadConfig = (cwd: string): Config => {
  const global = readJsonIfExists(globalConfigPath()) as Partial<Config> | undefined;
  const project = readJsonIfExists(projectConfigPath(cwd)) as Partial<Config> | undefined;

  let merged: Record<string, unknown> = { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>;
  if (global && typeof global === "object") {
    merged = deepMerge(merged, global as Record<string, unknown>);
  }
  if (project && typeof project === "object") {
    merged = deepMerge(merged, project as Record<string, unknown>);
  }

  const finalCfg = merged as unknown as Config;
  return applyAggression({ ...finalCfg, log_path: expandHome(finalCfg.log_path) });
};
