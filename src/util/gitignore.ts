import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// 0.1.8+: append `line` to `<path>/.gitignore` if absent.
//
// - Creates `.gitignore` (and parent dir) when missing.
// - Idempotent: skips when an existing entry matches `line` exactly, OR
//   matches `line + "/"` / `line.replace(/\/$/, "")` (so we don't add a
//   second variant when the user already wrote one or the other).
// - Best-effort: any IO failure is swallowed; never breaks the caller.
//   Graph build / raven enable proceed even if `.gitignore` is locked.
//
// Used by `buildGraph` after first successful save and `runEnable` after
// `ensureRavenStore`. Gated by `cfg.{graph,raven}.auto_gitignore` (default
// true).
export const appendGitignoreLine = (path: string, line: string): boolean => {
  try {
    const trimmed = line.trim();
    if (!trimmed) return false;
    const variants = new Set<string>([trimmed]);
    if (trimmed.endsWith("/")) variants.add(trimmed.slice(0, -1));
    else variants.add(`${trimmed}/`);
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      for (const existing of raw.split("\n")) {
        const t = existing.trim();
        if (t.length === 0 || t.startsWith("#")) continue;
        if (variants.has(t)) return false;
      }
      const needsLeadingNewline = raw.length > 0 && !raw.endsWith("\n");
      appendFileSync(path, `${needsLeadingNewline ? "\n" : ""}${trimmed}\n`);
      return true;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${trimmed}\n`);
    return true;
  } catch {
    // never break the caller — `.gitignore` patching is best-effort
    return false;
  }
};
