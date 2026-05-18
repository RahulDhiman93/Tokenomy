import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const TRANSIENT_CODES = new Set([
  "EAGAIN",
  "EBUSY",
  "ETXTBSY",
  "EPERM",
  "EACCES",
  "EMFILE",
]);

const isTransient = (err: unknown): boolean => {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
};

// Synchronous sleep — Atomics.wait blocks the calling thread for `ms`.
// Used between transient-error retries; called at most 3× per write
// with monotonically increasing delays.
const sleepSync = (ms: number): void => {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
};

const DEFAULT_BACKOFF_MS = [50, 150, 300];

export class AtomicWriteError extends Error {
  readonly path: string;
  override readonly cause: unknown;
  readonly attempts: number;
  // 0.1.10+ codex round 8 P3: surface the errno code so callers
  // branching on `(e as NodeJS.ErrnoException).code === "EACCES"`
  // keep working when they catch AtomicWriteError instead of the
  // raw fs throw. Pre-fix the wrapper hid the code, forcing every
  // caller to recurse into `cause.code`.
  readonly code?: string;
  constructor(path: string, cause: unknown, attempts: number) {
    super(`atomicWrite failed for ${path} after ${attempts} attempt(s): ${String(cause)}`);
    this.name = "AtomicWriteError";
    this.path = path;
    this.cause = cause;
    this.attempts = attempts;
    if (cause && typeof cause === "object") {
      const innerCode = (cause as { code?: unknown }).code;
      if (typeof innerCode === "string") this.code = innerCode;
    }
  }
}

// Test seam — tests overwrite individual entries before invoking
// atomicWrite. Production calls route through these bindings so stubs
// take effect.
export const _internal = {
  writeFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
  statSync,
  openSync,
  closeSync,
  fsyncSync,
  chmodSync,
  mkdirSync,
  backoffMs: [...DEFAULT_BACKOFF_MS],
};

type RetryOutcome =
  | { ok: true; attempts: number }
  | { ok: false; error: unknown; attempts: number };

const retrySync = (fn: () => void): RetryOutcome => {
  const backoff = _internal.backoffMs;
  let lastError: unknown;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      fn();
      return { ok: true, attempts: attempt + 1 };
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === backoff.length) {
        return { ok: false, error: err, attempts: attempt + 1 };
      }
      sleepSync(backoff[attempt] ?? 0);
    }
  }
  return { ok: false, error: lastError, attempts: backoff.length + 1 };
};

const cleanupTmp = (tmp: string): void => {
  try {
    _internal.unlinkSync(tmp);
  } catch {
    // best-effort
  }
};

export const atomicWrite = (
  targetPath: string,
  contents: string,
  preserveMode = true,
): void => {
  const dir = dirname(targetPath);
  _internal.mkdirSync(dir, { recursive: true });

  let mode: number | undefined;
  if (preserveMode) {
    try {
      mode = _internal.statSync(targetPath).mode & 0o777;
    } catch {
      mode = undefined;
    }
  }

  const tmp = join(
    dir,
    `.${basename(targetPath)}.tokenomy-tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );

  const writeRes = retrySync(() => _internal.writeFileSync(tmp, contents));
  if (!writeRes.ok) {
    cleanupTmp(tmp);
    throw new AtomicWriteError(targetPath, writeRes.error, writeRes.attempts);
  }

  try {
    const fd = _internal.openSync(tmp, "r+");
    try {
      _internal.fsyncSync(fd);
    } finally {
      _internal.closeSync(fd);
    }
  } catch {
    // fsync best-effort
  }

  const renameRes = retrySync(() => _internal.renameSync(tmp, targetPath));
  let totalAttempts = writeRes.attempts + renameRes.attempts;
  if (!renameRes.ok) {
    try {
      _internal.copyFileSync(tmp, targetPath);
      cleanupTmp(tmp);
      totalAttempts += 1;
    } catch (copyErr) {
      cleanupTmp(tmp);
      throw new AtomicWriteError(targetPath, copyErr, totalAttempts + 1);
    }
  }

  if (mode !== undefined) {
    try {
      _internal.chmodSync(targetPath, mode);
    } catch {
      // best-effort
    }
  }

  try {
    const tfd = _internal.openSync(targetPath, "r");
    try {
      _internal.fsyncSync(tfd);
    } finally {
      _internal.closeSync(tfd);
    }
  } catch {
    // best-effort
  }

  try {
    const dfd = _internal.openSync(dir, "r");
    try {
      _internal.fsyncSync(dfd);
    } finally {
      _internal.closeSync(dfd);
    }
  } catch {
    // Some filesystems (e.g. certain network mounts) disallow directory fsync;
    // the rename above is still visible to subsequent reads.
  }
};
