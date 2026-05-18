import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, basename, join } from "node:path";

// 0.1.10+ P12c: cap how many `.tokenomy-bak-*` siblings of any
// particular file accumulate. Init/uninstall cycles previously left
// every snapshot ever taken — long-running users saw hundreds piled
// up next to settings.json. Keep the newest N; best-effort delete
// older ones.
const BACKUP_RETENTION_COUNT = 10;

const pruneBackups = (dir: string, originalBasename: string): void => {
  const prefix = `${originalBasename}.tokenomy-bak-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const siblings: { name: string; mtimeMs: number }[] = [];
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    siblings.push({ name, mtimeMs });
  }
  if (siblings.length <= BACKUP_RETENTION_COUNT) return;
  siblings.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
  for (const old of siblings.slice(BACKUP_RETENTION_COUNT)) {
    try {
      unlinkSync(join(dir, old.name));
    } catch {
      // best-effort
    }
  }
};

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
  pruneBackups(dir, basename(path));
  return candidate;
};
