import { copyFileSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";

export const backupFile = (path: string): string | null => {
  if (!existsSync(path)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const baseName = `${basename(path)}.tokenomy-bak-${ts}`;
  const dir = dirname(path);
  let candidate = join(dir, baseName);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${baseName}.${counter}`);
    counter++;
  }
  copyFileSync(path, candidate);
  return candidate;
};
