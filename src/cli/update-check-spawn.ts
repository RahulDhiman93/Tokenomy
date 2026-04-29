import { spawn } from "node:child_process";

// 0.1.3+: detached, non-blocking spawn of `tokenomy update --check`.
//
// Used by the SessionStart hook (so users notice new releases the moment
// they restart Claude Code) and by the statusline (every 3h when the
// cache ages out). Both paths must NEVER block the user's session, so we:
//
//   - spawn `tokenomy update --check` with stdio: 'ignore'
//   - call .unref() so the parent can exit independently
//   - swallow all errors (no `tokenomy` on PATH, no network, etc. all
//     leave the cache as-is)
//
// The actual check writes `~/.tokenomy/update-cache.json` if a newer
// release exists. The next `readUpdateCache()` tick picks it up.
//
// Idempotent: a process-local guard prevents two spawns in the same Node
// process (which would race on the cache write). The on-disk
// `update-cache.json` mtime acts as the cross-process throttle via
// `shouldRefreshUpdateCache`.
let inFlight = false;

export const spawnUpdateCheck = (): void => {
  if (inFlight) return;
  inFlight = true;
  try {
    const child = spawn("tokenomy", ["update", "--check", "--quiet"], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {
      inFlight = false;
    });
    child.on("exit", () => {
      inFlight = false;
    });
    child.unref();
  } catch {
    inFlight = false;
  }
};
