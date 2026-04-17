import { closeSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";

export const sha256String = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

export const sha256FileSync = (path: string): string => {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
};
