import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SavingsLogEntry } from "./types.js";

export const appendSavingsLog = (logPath: string, entry: SavingsLogEntry): void => {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(entry) + "\n", { flag: "a" });
  } catch {
    // Best-effort: logging must never break the hook.
  }
};
