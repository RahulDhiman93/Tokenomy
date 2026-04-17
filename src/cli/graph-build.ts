import { stableStringify } from "../util/json.js";
import { buildGraph } from "../graph/build.js";
import { loadConfig } from "../core/config.js";

export const runGraphBuild = async (opts: {
  cwd: string;
  path?: string;
  force?: boolean;
}): Promise<number> => {
  const target = opts.path ?? opts.cwd;
  const result = await buildGraph({
    cwd: target,
    force: opts.force,
    config: loadConfig(target),
  });
  process.stdout.write(`${stableStringify(result)}\n`);
  return result.ok ? 0 : 1;
};
