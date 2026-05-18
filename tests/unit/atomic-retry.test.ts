import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _internal,
  AtomicWriteError,
  atomicWrite,
} from "../../src/util/atomic.js";

const withTmp = (fn: (dir: string) => void): void => {
  const dir = mkdtempSync(join(tmpdir(), "tokenomy-atomic-retry-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const restoreInternal = (snap: typeof _internal): void => {
  Object.assign(_internal, snap);
};

const snapshotInternal = (): typeof _internal => ({ ..._internal });

const errno = (code: string): NodeJS.ErrnoException => {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

test("atomicWrite: writes file successfully when no errors", () => {
  withTmp((dir) => {
    const target = join(dir, "out.json");
    atomicWrite(target, '{"a":1}');
    assert.equal(readFileSync(target, "utf8"), '{"a":1}');
  });
});

test("atomicWrite: retries writeFileSync on EAGAIN and eventually succeeds", () => {
  withTmp((dir) => {
    const snap = snapshotInternal();
    _internal.backoffMs = [0, 0, 0];
    let remainingFails = 2;
    const real = snap.writeFileSync;
    let calls = 0;
    _internal.writeFileSync = ((p: string, c: string | Buffer) => {
      calls++;
      if (remainingFails > 0) {
        remainingFails--;
        throw errno("EAGAIN");
      }
      return real(p, c);
    }) as typeof real;
    try {
      const target = join(dir, "out.txt");
      atomicWrite(target, "hello", false);
      assert.equal(readFileSync(target, "utf8"), "hello");
      assert.equal(calls, 3);
    } finally {
      restoreInternal(snap);
    }
  });
});

test("atomicWrite: retries renameSync on EBUSY and eventually succeeds", () => {
  withTmp((dir) => {
    const snap = snapshotInternal();
    _internal.backoffMs = [0, 0, 0];
    const real = snap.renameSync;
    let remainingFails = 2;
    let calls = 0;
    _internal.renameSync = ((from: string, to: string) => {
      calls++;
      if (remainingFails > 0) {
        remainingFails--;
        throw errno("EBUSY");
      }
      return real(from, to);
    }) as typeof real;
    try {
      const target = join(dir, "out.txt");
      atomicWrite(target, "data", false);
      assert.equal(readFileSync(target, "utf8"), "data");
      assert.equal(calls, 3);
    } finally {
      restoreInternal(snap);
    }
  });
});

test("atomicWrite: falls back to copyFileSync when renameSync exhausts retries", () => {
  withTmp((dir) => {
    const snap = snapshotInternal();
    _internal.backoffMs = [0, 0, 0];
    let renameCalls = 0;
    let copyCalls = 0;
    _internal.renameSync = (() => {
      renameCalls++;
      throw errno("EPERM");
    }) as typeof snap.renameSync;
    const realCopy = snap.copyFileSync;
    _internal.copyFileSync = ((from: string, to: string) => {
      copyCalls++;
      return realCopy(from, to);
    }) as typeof realCopy;
    try {
      const target = join(dir, "win.txt");
      atomicWrite(target, "fallback", false);
      assert.equal(readFileSync(target, "utf8"), "fallback");
      assert.equal(renameCalls, 4); // 1 initial + 3 retries
      assert.equal(copyCalls, 1);
    } finally {
      restoreInternal(snap);
    }
  });
});

test("atomicWrite: throws AtomicWriteError on non-transient EISDIR immediately", () => {
  withTmp((dir) => {
    const snap = snapshotInternal();
    _internal.backoffMs = [0, 0, 0];
    let calls = 0;
    _internal.writeFileSync = (() => {
      calls++;
      throw errno("EISDIR");
    }) as typeof snap.writeFileSync;
    try {
      const target = join(dir, "bad.txt");
      assert.throws(
        () => atomicWrite(target, "x", false),
        (err: unknown) => {
          assert.ok(err instanceof AtomicWriteError, "instanceof AtomicWriteError");
          assert.equal((err as AtomicWriteError).path, target);
          assert.equal((err as AtomicWriteError).attempts, 1);
          assert.equal(((err as AtomicWriteError).cause as NodeJS.ErrnoException).code, "EISDIR");
          return true;
        },
      );
      assert.equal(calls, 1);
    } finally {
      restoreInternal(snap);
    }
  });
});

test("atomicWrite: throws AtomicWriteError after retry exhaustion on persistent EAGAIN", () => {
  withTmp((dir) => {
    const snap = snapshotInternal();
    _internal.backoffMs = [0, 0, 0];
    let calls = 0;
    _internal.writeFileSync = (() => {
      calls++;
      throw errno("EAGAIN");
    }) as typeof snap.writeFileSync;
    try {
      const target = join(dir, "loop.txt");
      assert.throws(
        () => atomicWrite(target, "x", false),
        (err: unknown) => {
          assert.ok(err instanceof AtomicWriteError);
          assert.equal((err as AtomicWriteError).attempts, 4); // 1 + 3 retries
          return true;
        },
      );
      assert.equal(calls, 4);
    } finally {
      restoreInternal(snap);
    }
  });
});

test("atomicWrite: cleans up tmp file on hard failure", () => {
  withTmp((dir) => {
    const snap = snapshotInternal();
    _internal.backoffMs = [0, 0, 0];
    _internal.writeFileSync = (() => {
      throw errno("EACCES");
    }) as typeof snap.writeFileSync;
    try {
      const target = join(dir, "leak.txt");
      try {
        atomicWrite(target, "data", false);
      } catch {
        // expected
      }
      const orphans = readdirSync(dir).filter((f) => f.includes("tokenomy-tmp-"));
      assert.equal(orphans.length, 0, `expected no tmp orphans, found: ${orphans.join(",")}`);
    } finally {
      restoreInternal(snap);
    }
  });
});

test("atomicWrite: copyFileSync fallback also fails surfaces AtomicWriteError", () => {
  withTmp((dir) => {
    const snap = snapshotInternal();
    _internal.backoffMs = [0, 0, 0];
    _internal.renameSync = (() => {
      throw errno("EPERM");
    }) as typeof snap.renameSync;
    _internal.copyFileSync = (() => {
      throw errno("ENOSPC");
    }) as typeof snap.copyFileSync;
    try {
      const target = join(dir, "doom.txt");
      assert.throws(
        () => atomicWrite(target, "data", false),
        (err: unknown) => {
          assert.ok(err instanceof AtomicWriteError);
          assert.equal(
            ((err as AtomicWriteError).cause as NodeJS.ErrnoException).code,
            "ENOSPC",
          );
          return true;
        },
      );
      // tmp must be cleaned up even when both rename + copy fail
      const orphans = readdirSync(dir).filter((f) => f.includes("tokenomy-tmp-"));
      assert.equal(orphans.length, 0);
    } finally {
      restoreInternal(snap);
    }
  });
});

test("atomicWrite: preserveMode true preserves existing file mode", () => {
  withTmp((dir) => {
    const target = join(dir, "modey.txt");
    // First write with default mode
    atomicWrite(target, "v1", false);
    // chmod to a non-default mode
    chmodSync(target, 0o600);
    const before = statSync(target).mode & 0o777;
    assert.equal(before, 0o600);
    // Overwrite with preserveMode=true
    atomicWrite(target, "v2", true);
    const after = statSync(target).mode & 0o777;
    assert.equal(after, 0o600);
    assert.equal(readFileSync(target, "utf8"), "v2");
  });
});

test("atomicWrite: target written after rename even if dir fsync unsupported", () => {
  withTmp((dir) => {
    const snap = snapshotInternal();
    // Simulate FS where openSync on dir throws (dir fsync best-effort)
    const realOpen = snap.openSync;
    _internal.openSync = ((p: string, flags: string) => {
      if (p === dir) {
        throw errno("ENOTSUP");
      }
      return realOpen(p, flags);
    }) as typeof realOpen;
    try {
      const target = join(dir, "ok.txt");
      atomicWrite(target, "robust", false);
      assert.equal(readFileSync(target, "utf8"), "robust");
      assert.ok(existsSync(target));
    } finally {
      restoreInternal(snap);
    }
  });
});
