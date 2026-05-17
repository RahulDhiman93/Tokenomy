export const safeParse = <T = unknown>(s: string): T | undefined => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
};

// 0.1.10+ P8a: kept name for back-compat with the ~15 callers
// (config writes, fixture files) that benefit from indented output.
// Actual behavior is "pretty-print with 2-space indent", NOT stable
// key sorting — Object.keys iteration order is insertion order in
// modern JS, which is what the file already relied on.
export const stableStringify = (v: unknown): string => JSON.stringify(v, null, 2);

// 0.1.10+ P8a: compact (no indent) JSON for the MCP response path
// where every byte over the wire counts. Pre-0.1.10 mcp/server.ts
// emitted indented JSON via stableStringify, inflating responses by
// ~30-50% on typical payloads.
export const compactJson = (v: unknown): string => JSON.stringify(v);
