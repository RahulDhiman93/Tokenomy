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

  // 0.1.10+ P8c: binary-search truncation. Pre-0.1.10 the loop did
  // `slice(0, n-1)` + a full stringify per dropped element — O(n)
  // stringifies for a 10K-element array clipped to half its size.
  // Now: for the currently-largest array, binary-search the largest
  // prefix length that still fits under budget. O(log n) stringifies
  // per array, repeated until either we fit or no array has elements
  // left to drop.
  let totalDropped = 0;
  let safety = 32; // hard cap on outer iterations across distinct arrays
  while (utf8Bytes(serialized) > budgetBytes && safety-- > 0) {
    const candidates = findArrayPaths(copy)
      .filter((candidate) => candidate.length > 0)
      .sort((a, b) => b.length - a.length);
    const largest = candidates[0];
    if (!largest) break;
    const arr = getAtPath(copy, largest.path);
    if (!Array.isArray(arr) || arr.length === 0) break;
    const origLen = arr.length;
    let lo = 0;
    let hi = origLen;
    // Find the largest len in [0, origLen) such that the result fits.
    // Even at len=0 the result might still exceed budget — in that
    // case we drop the entire array and let the next iteration target
    // the next-largest array.
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      const trimmed = arr.slice(0, mid);
      setAtPath(copy, largest.path, trimmed);
      const probe = utf8Bytes(JSON.stringify(copy));
      if (probe <= budgetBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    // Commit the largest length that fit; if 0 fits, that's still the
    // commit and we'll move to the next-largest array on the next pass.
    setAtPath(copy, largest.path, arr.slice(0, lo));
    totalDropped += origLen - lo;
    serialized = JSON.stringify(copy);
    if (lo === origLen) break; // nothing dropped this round — bail
    // 0.1.10+ codex round 6 P2: even when lo=0 (couldn't keep any
    // elements of THIS array), continue iterating — the next-largest
    // array might still trim to a positive prefix that fits the
    // remaining budget. Pre-fix the loop only broke on "no
    // candidates left", but a binary-search to 0 on one array while
    // others stayed full silently zeroed one section.
  }

  if (totalDropped > 0 && copy.ok) {
    copy.truncated = { dropped_count: totalDropped };
  }
  return copy;
};

export const limitByCount = <T>(items: T[], max: number): T[] => items.slice(0, Math.max(0, max));
