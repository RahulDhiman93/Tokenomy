import { createHash } from "node:crypto";

// Tiny LRU keyed by (tool, args, graphVersion). Lives for the lifetime of
// the MCP server process; intentionally bounded so a long-running server
// doesn't slowly eat memory on repeated queries.
//
// We do NOT cache build_or_update_graph (it's a write) — and the cache is
// automatically invalidated by a version bump: the handler reads the graph
// meta.built_at to form the version key.

const DEFAULT_MAX = 32;

interface Entry {
  value: unknown;
  hits: number;
}

export class QueryCache {
  private map = new Map<string, Entry>();
  constructor(private readonly max = DEFAULT_MAX) {}

  key(tool: string, args: unknown, version: string): string {
    const canonical = JSON.stringify(canonicalize(args));
    return createHash("sha256")
      .update(tool)
      .update("\u0000")
      .update(canonical)
      .update("\u0000")
      .update(version)
      .digest("hex");
  }

  get(key: string): unknown | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Touch: move to the end (most-recently used).
    this.map.delete(key);
    this.map.set(key, entry);
    entry.hits++;
    return entry.value;
  }

  set(key: string, value: unknown): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, hits: 0 });
    while (this.map.size > this.max) {
      // Evict oldest.
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  invalidate(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const canonicalize = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const k of keys) out[k] = canonicalize((value as Record<string, unknown>)[k]);
  return out;
};
