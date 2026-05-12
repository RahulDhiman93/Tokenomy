import { stableStringify } from "../util/json.js";
import { loadConfig } from "../core/config.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { readGraphStatus } from "../graph/build.js";

export const runGraphStatus = async (opts: { cwd: string; path?: string }): Promise<number> => {
  const target = opts.path ?? opts.cwd;
  // 0.1.8+ codex round 7: load cfg from resolved repo root.
  const identity = resolveRepoId(target);
  const result = readGraphStatus(target, loadConfig(identity.repoPath));
  process.stdout.write(`${stableStringify(result)}\n`);
  return result.ok ? 0 : 1;
};
