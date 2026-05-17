import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// 0.1.10+ P6c: lock the `git` binary to a verified absolute path
// from a known-safe prefix. Pre-0.1.10 `execFileSync("git", ...)`
// went through PATH; any writable dir earlier on the user's PATH
// could shadow git with a trojan that exfiltrates repo contents
// during `tokenomy graph build` / `repo-id` resolution.

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

const which = (): string | null => {
  // Explicit override always wins, even when it falls outside the
  // safe-prefix whitelist. Use cases: airgapped systems, custom git
  // builds, container images with git in /opt/git/bin/, etc.
  const explicit = process.env["GIT_EXEC_PATH"];
  if (explicit && explicit.length > 0) return explicit;
  try {
    const cmd = isPosix() ? "which" : "where";
    const out = execFileSync(cmd, ["git"], { encoding: "utf8" }).trim();
    // `where` on Windows may return multiple lines; pick the first.
    const first = out.split(/\r?\n/)[0]?.trim() ?? "";
    return first.length > 0 ? first : null;
  } catch {
    return null;
  }
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
  if (process.env["GIT_EXEC_PATH"] === resolved) {
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
          "falling back to PATH lookup. Set GIT_EXEC_PATH to the absolute git path to silence this.\n",
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
