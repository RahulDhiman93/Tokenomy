import { utf8Bytes } from "../../rules/text-trim.js";

// 0.1.9+ codex round 13 P2: freshness metadata at the top level
// (stale_files, stale_in_scope) is signal, not payload. Truncating
// it produces an answer with `stale: true` and empty
// `stale_in_scope` — callers misread that as "drift exists but is
// unrelated" even when an in-scope edit was simply clipped away.
const PROTECTED_TOP_KEYS = new Set(["stale_files", "stale_in_scope"]);

const findArrayPaths = (
  value: unknown,
  path: Array<string | number> = [],
  out: Array<{ path: Array<string | number>; length: number }> = [],
): Array<{ path: Array<string | number>; length: number }> => {
  if (Array.isArray(value)) {
    out.push({ path, length: value.length });
    value.forEach((item, index) => findArrayPaths(item, [...path, index], out));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      // Skip protected top-level arrays — never let the clipper
      // drop entries from them.
      if (path.length === 0 && PROTECTED_TOP_KEYS.has(key)) continue;
      findArrayPaths(child, [...path, key], out);
    }
  }
  return out;
};

const getAtPath = (root: unknown, path: Array<string | number>): unknown =>
  path.reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part as string] : undefined), root);

const cloneValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const setAtPath = (root: unknown, path: Array<string | number>, next: unknown): void => {
  if (path.length === 0) return;
  let current = root as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    current = current[path[i] as string] as Record<string, unknown>;
  }
  current[path[path.length - 1] as string] = next;
};

export const clipResultToBudget = <T extends { ok: boolean; truncated?: { dropped_count: number } }>(
  result: T,
  budgetBytes: number,
): T => {
  const copy = cloneValue(result);
  let serialized = JSON.stringify(copy);
  if (utf8Bytes(serialized) <= budgetBytes) return copy;

  let dropped = 0;
  while (utf8Bytes(serialized) > budgetBytes) {
    const candidates = findArrayPaths(copy)
      .filter((candidate) => candidate.length > 0)
      .sort((a, b) => b.length - a.length);
    const largest = candidates[0];
    if (!largest) break;
    const arr = getAtPath(copy, largest.path);
    if (!Array.isArray(arr) || arr.length === 0) break;
    const next = arr.slice(0, arr.length - 1);
    setAtPath(copy, largest.path, next);
    dropped++;
    serialized = JSON.stringify(copy);
  }

  if (dropped > 0 && copy.ok) {
    copy.truncated = { dropped_count: dropped };
  }
  return copy;
};

export const limitByCount = <T>(items: T[], max: number): T[] => items.slice(0, Math.max(0, max));
