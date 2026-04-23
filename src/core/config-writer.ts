import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { globalConfigPath } from "./paths.js";
import { safeParse } from "../util/json.js";

// Safe writer for ~/.tokenomy/config.json. Always writes a timestamped
// backup before mutating. Supports two patch ops:
//   - "add":    set a dotted path to a new value (overwrites scalar / object)
//   - "append": ensure the dotted path points to an array, then push value
//               unless it's already present

export interface ConfigPatch {
  path: string;
  op: "add" | "append";
  value: unknown;
}

const splitPath = (path: string): string[] => path.split(".").filter(Boolean);

const ensureObject = (parent: Record<string, unknown>, key: string): Record<string, unknown> => {
  const existing = parent[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
};

const applyPatch = (cfg: Record<string, unknown>, patch: ConfigPatch): void => {
  const parts = splitPath(patch.path);
  if (parts.length === 0) return;
  let cursor = cfg;
  for (let i = 0; i < parts.length - 1; i++) cursor = ensureObject(cursor, parts[i]!);
  const leaf = parts[parts.length - 1]!;
  if (patch.op === "add") {
    cursor[leaf] = patch.value;
    return;
  }
  // append
  const current = cursor[leaf];
  const arr: unknown[] = Array.isArray(current) ? [...current] : [];
  if (!arr.includes(patch.value)) arr.push(patch.value);
  cursor[leaf] = arr;
};

export interface ApplyResult {
  config_path: string;
  backup_path: string;
  applied: number;
}

export const applyProposals = (patches: ConfigPatch[]): ApplyResult => {
  const path = globalConfigPath();
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${path}.bak-${now}`;
  let cfg: Record<string, unknown> = {};
  if (existsSync(path)) {
    copyFileSync(path, backup);
    cfg = (safeParse<Record<string, unknown>>(readFileSync(path, "utf8")) as Record<string, unknown>) ?? {};
  }
  for (const p of patches) applyPatch(cfg, p);
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return { config_path: path, backup_path: backup, applied: patches.length };
};
