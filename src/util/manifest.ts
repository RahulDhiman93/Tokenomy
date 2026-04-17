import { existsSync, readFileSync, rmSync } from "node:fs";
import type { Manifest, ManifestEntry } from "../core/types.js";
import { manifestPath } from "../core/paths.js";
import { atomicWrite } from "./atomic.js";
import { safeParse, stableStringify } from "./json.js";

const EMPTY: Manifest = { version: 1, entries: [] };

export const readManifest = (): Manifest => {
  const p = manifestPath();
  if (!existsSync(p)) return { ...EMPTY };
  const parsed = safeParse<Manifest>(readFileSync(p, "utf8"));
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return { ...EMPTY };
  }
  return parsed;
};

export const writeManifest = (m: Manifest): void => {
  atomicWrite(manifestPath(), stableStringify(m) + "\n", false);
};

export const upsertEntry = (m: Manifest, entry: ManifestEntry): Manifest => {
  const filtered = m.entries.filter(
    (e) => !(e.command_path === entry.command_path && e.settings_path === entry.settings_path),
  );
  return { ...m, entries: [...filtered, entry] };
};

export const removeEntryByCommand = (m: Manifest, commandPath: string): Manifest => ({
  ...m,
  entries: m.entries.filter((e) => e.command_path !== commandPath),
});

export const deleteManifestFile = (): void => {
  try {
    rmSync(manifestPath(), { force: true });
  } catch {
    // ignore
  }
};
