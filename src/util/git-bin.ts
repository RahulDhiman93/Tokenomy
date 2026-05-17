import { existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

// 0.1.10+ P6c: lock the `git` binary to a verified absolute path
// from a known-safe prefix. Pre-0.1.10 `execFileSync("git", ...)`
// went through PATH; any writable dir earlier on the user's PATH
// could shadow git with a trojan that exfiltrates repo contents
// during `tokenomy graph build` / `repo-id` resolution.
//
// codex round 2 P2: do not spawn `which` / `where` — those resolve
// through PATH themselves and re-introduce the same hijack surface.
// Resolve PATH entries in-process by walking process.env.PATH and
// statting each candidate.
//
// codex round 2 P2: TOKENOMY_GIT_BIN replaces the earlier
// GIT_EXEC_PATH override. GIT_EXEC_PATH is Git's own env for the
// helpers directory (e.g. /usr/libexec/git-core) — overloading it
// to mean "absolute path to the git binary" produced a directory
// when users had Git set up correctly, breaking repo-id resolution.

const SAFE_PREFIXES_POSIX = [
  "/usr/bin/",
  "/usr/local/bin/",
  "/opt/",
  "/Applications/",
];

const SAFE_PREFIXES_WIN = [
  "C:\\Program Files\\Git\\",
  "C:\\Program Files (x86)\\Git\\",
];

const isPosix = (): boolean => process.platform !== "win32";

const isUnderSafePrefix = (absPath: string): boolean => {
  const prefixes = isPosix() ? SAFE_PREFIXES_POSIX : SAFE_PREFIXES_WIN;
  for (const prefix of prefixes) {
    if (absPath.startsWith(prefix)) return true;
  }
  return false;
};

// In-process PATH walk. No subprocess, no helper executed; we just
// check whether each PATH entry contains an executable `git` file.
const resolvePathInProcess = (): string | null => {
  const path = process.env["PATH"];
  if (!path) return null;
  const entries = path.split(delimiter).filter((e) => e.length > 0);
  const candidates = isPosix() ? ["git"] : ["git.exe", "git.cmd"];
  for (const entry of entries) {
    for (const name of candidates) {
      const full = join(entry, name);
      try {
        const st = statSync(full);
        if (st.isFile()) return full;
      } catch {
        // missing or unreadable — try next
      }
    }
  }
  return null;
};

const which = (): string | null => {
  // Explicit override always wins, even when it falls outside the
  // safe-prefix whitelist. Use cases: airgapped systems, custom git
  // builds, container images with git in /opt/git/bin/, etc.
  const explicit = process.env["TOKENOMY_GIT_BIN"];
  if (explicit && explicit.length > 0) {
    try {
      if (statSync(explicit).isFile()) return explicit;
    } catch {
      // fall through to PATH-walk; explicit was a typo or stale env
    }
  }
  return resolvePathInProcess();
};

let cached: string | null | undefined = undefined;
let warnedUnsafe = false;

// Returns the verified absolute git binary path, or null when no
// safe binary is available. Cached for the process lifetime — the
// resolution syscalls are cheap but adding them on every git call
// would matter on hot paths (repo-id, stale check).
export const getVerifiedGitBin = (): string | null => {
  if (cached !== undefined) return cached;
  const resolved = which();
  if (resolved === null) {
    cached = null;
    return null;
  }
  if (process.env["TOKENOMY_GIT_BIN"] === resolved) {
    // Explicit override — trust it.
    cached = resolved;
    return resolved;
  }
  if (!existsSync(resolved)) {
    cached = null;
    return null;
  }
  if (!isUnderSafePrefix(resolved)) {
    if (!warnedUnsafe) {
      warnedUnsafe = true;
      process.stderr.write(
        `[tokenomy] git-bin-untrusted-path ${resolved}: not under a known-safe prefix; ` +
          "falling back to PATH lookup. Set TOKENOMY_GIT_BIN to the absolute git path to silence this.\n",
      );
    }
    // Don't return the unsafe path; let caller fall back to plain
    // "git" via PATH (matches pre-0.1.10 behavior; the warning
    // surfaces the risk).
    cached = null;
    return null;
  }
  cached = resolved;
  return resolved;
};

// Test affordance.
export const _resetGitBinForTests = (): void => {
  cached = undefined;
  warnedUnsafe = false;
};
