import { existsSync, readFileSync } from "node:fs";
import { globalConfigPath } from "../core/paths.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { atomicWrite } from "../util/atomic.js";
import { safeParse, stableStringify } from "../util/json.js";

const parseValue = (v: string): unknown => {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
  const j = safeParse(v);
  return j !== undefined ? j : v;
};

const readRaw = (): Record<string, unknown> => {
  const p = globalConfigPath();
  if (!existsSync(p)) return { ...DEFAULT_CONFIG } as unknown as Record<string, unknown>;
  return (safeParse<Record<string, unknown>>(readFileSync(p, "utf8")) ??
    ({ ...DEFAULT_CONFIG } as unknown as Record<string, unknown>));
};

export const configGet = (key: string): unknown => {
  const cfg = readRaw();
  const parts = key.split(".");
  let cur: unknown = cfg;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
};

export const configSet = (key: string, value: string): void => {
  const cfg = readRaw();
  const parts = key.split(".");
  let cur: Record<string, unknown> = cfg;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = parseValue(value);
  atomicWrite(globalConfigPath(), stableStringify(cfg) + "\n", false);
};
