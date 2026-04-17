import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";

export const atomicWrite = (
  targetPath: string,
  contents: string,
  preserveMode = true,
): void => {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });

  let mode: number | undefined;
  if (preserveMode) {
    try {
      mode = statSync(targetPath).mode & 0o777;
    } catch {
      mode = undefined;
    }
  }

  const tmp = join(dir, `.${basename(targetPath)}.tokenomy-tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, contents);
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, targetPath);
  if (mode !== undefined) chmodSync(targetPath, mode);

  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Some filesystems (e.g. certain network mounts) disallow directory fsync;
    // the rename above is still visible to subsequent reads.
  }
};
