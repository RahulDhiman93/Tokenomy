import type { Config } from "./types.js";

export const estimateTokens = (bytes: number): number => Math.ceil(bytes / 4);

export const shouldApply = (
  textBytesIn: number,
  textBytesOut: number,
  cfg: Config,
): boolean => {
  const savedBytes = textBytesIn - textBytesOut;
  if (savedBytes <= 0) return false;
  if (textBytesIn >= cfg.gate.always_trim_above_bytes) return true;
  if (savedBytes < cfg.gate.min_saved_bytes) return false;
  const savedPct = textBytesIn > 0 ? savedBytes / textBytesIn : 0;
  return savedPct >= cfg.gate.min_saved_pct;
};
