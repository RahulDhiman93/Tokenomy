import { stableStringify } from "../util/json.js";
import { loadConfig } from "../core/config.js";
import { readGraphStatus } from "../graph/build.js";

export const runGraphStatus = async (opts: { cwd: string; path?: string }): Promise<number> => {
  const target = opts.path ?? opts.cwd;
  const result = readGraphStatus(target, loadConfig(target));
  process.stdout.write(`${stableStringify(result)}\n`);
  return result.ok ? 0 : 1;
};
