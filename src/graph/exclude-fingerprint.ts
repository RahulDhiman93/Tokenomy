import { createHash } from "node:crypto";

export const fingerprintExcludes = (patterns: readonly string[]): string =>
  createHash("sha256")
    .update(JSON.stringify([...new Set(patterns)].sort()))
    .digest("hex");
