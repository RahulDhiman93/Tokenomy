import { utf8Bytes } from "./text-trim.js";

export interface ShapeTrimOptions {
  max_items: number;
  max_string_bytes: number;
}

export interface ShapeTrimResult {
  ok: boolean;
  trimmed?: string;
  bytesIn?: number;
  bytesOut?: number;
  kept?: number;
  dropped?: number;
  shape?: "array" | `wrapped:${string}`;
  reason?: string;
}

// Shape-trim preserves row structure for inventory-shaped JSON responses the
// profile system doesn't cover. Unlike head+tail byte trim, every row
// survives — only per-row strings get truncated and deeply nested objects
// get dropped. This is the right fallback for enumeration endpoints where
// the *set* is what the caller needs (transition lists, issue-type menus,
// project rosters) rather than any single row's detail.

// Common keys that wrap an array of records in a single top-level property.
// Order matters — first hit wins when multiple are present.
const WRAPPER_KEYS = [
  "transitions",
  "issues",
  "items",
  "values",
  "results",
  "data",
  "entries",
  "records",
] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// ≥ 80 % of the sampled rows must share ≥ 80 % of the first row's keys.
// Not a strict equality — rows with occasional missing keys (e.g. null
// assignee) are still considered homogeneous.
const HOMOGENEITY_RATIO = 0.8;
const HOMOGENEITY_KEY_RATIO = 0.8;

const isHomogeneousRecordArray = (arr: unknown[]): boolean => {
  if (arr.length === 0) return false;
  const objects = arr.filter(isObject);
  if (objects.length / arr.length < HOMOGENEITY_RATIO) return false;
  const first = objects[0]!;
  const baseline = Object.keys(first);
  if (baseline.length === 0) return false;
  const threshold = Math.ceil(baseline.length * HOMOGENEITY_KEY_RATIO);
  let hits = 0;
  for (const row of objects) {
    const keys = new Set(Object.keys(row));
    let shared = 0;
    for (const k of baseline) if (keys.has(k)) shared++;
    if (shared >= threshold) hits++;
  }
  return hits / objects.length >= HOMOGENEITY_RATIO;
};

// Truncate a string value to max_string_bytes with an explicit marker. Keeps
// head; drops the middle/tail. Arrays and objects pass through to the
// depth-aware path below.
const trimString = (s: string, maxBytes: number): string => {
  if (utf8Bytes(s) <= maxBytes) return s;
  const buf = Buffer.from(s, "utf8");
  const head = buf.subarray(0, Math.max(1, maxBytes)).toString("utf8");
  return `${head}…[tokenomy: elided ${utf8Bytes(s) - utf8Bytes(head)} bytes]`;
};

// Depth-aware row compactor. Keeps primitives, truncates strings, recurses
// one level into nested objects, but drops anything deeper than depth 2 and
// any nested arrays (those are where payloads balloon).
const compactValue = (
  v: unknown,
  depth: number,
  maxStringBytes: number,
): unknown => {
  if (v === null) return null;
  if (typeof v === "string") return trimString(v, maxStringBytes);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    // Nested arrays are the most common source of row bloat (labels,
    // history, comments). Drop the contents but keep the length as a hint.
    return v.length === 0 ? [] : [`[tokenomy: elided ${v.length} items]`];
  }
  if (isObject(v)) {
    if (depth >= 3) return "[tokenomy: nested object elided]";
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v)) {
      out[k] = compactValue(child, depth + 1, maxStringBytes);
    }
    return out;
  }
  return v;
};

const compactRow = (row: Record<string, unknown>, maxStringBytes: number): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = compactValue(v, 1, maxStringBytes);
  }
  return out;
};

interface ShapeDetected {
  rows: unknown[];
  rebuild: (trimmedRows: unknown[]) => unknown;
  shape: ShapeTrimResult["shape"];
}

const detectShape = (parsed: unknown): ShapeDetected | null => {
  if (Array.isArray(parsed) && isHomogeneousRecordArray(parsed)) {
    return {
      rows: parsed,
      rebuild: (rows) => rows,
      shape: "array",
    };
  }
  if (isObject(parsed)) {
    for (const key of WRAPPER_KEYS) {
      const child = parsed[key];
      if (Array.isArray(child) && isHomogeneousRecordArray(child)) {
        return {
          rows: child,
          rebuild: (rows) => ({ ...parsed, [key]: rows }),
          shape: `wrapped:${key}`,
        };
      }
    }
  }
  return null;
};

export const shapeTrim = (text: string, opts: ShapeTrimOptions): ShapeTrimResult => {
  const bytesIn = utf8Bytes(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-json", bytesIn };
  }
  const detected = detectShape(parsed);
  if (!detected) return { ok: false, reason: "no-inventory-shape", bytesIn };

  const keep = Math.max(1, opts.max_items);
  const head = detected.rows.slice(0, keep);
  const dropped = Math.max(0, detected.rows.length - keep);
  const compacted = head.map((r) =>
    isObject(r) ? compactRow(r, opts.max_string_bytes) : r,
  );
  const withMarker =
    dropped > 0
      ? [...compacted, `[tokenomy: elided ${dropped} rows]`]
      : compacted;
  const rebuilt = detected.rebuild(withMarker);
  const trimmed = JSON.stringify(rebuilt);
  const bytesOut = utf8Bytes(trimmed);

  // Bail if the compact form grew (pathological: every field was already
  // under max_string_bytes and the marker overhead outweighed savings).
  if (bytesOut >= bytesIn) {
    return { ok: false, reason: "no-savings", bytesIn };
  }

  return {
    ok: true,
    trimmed,
    bytesIn,
    bytesOut,
    kept: head.length,
    dropped,
    shape: detected.shape,
  };
};
