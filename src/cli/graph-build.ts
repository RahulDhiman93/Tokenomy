import { stableStringify } from "../util/json.js";
import { buildGraph } from "../graph/build.js";
import { loadConfig } from "../core/config.js";
import type { Config } from "../core/types.js";

export const runGraphBuild = async (opts: {
  cwd: string;
  path?: string;
  force?: boolean;
  exclude?: string[];
}): Promise<number> => {
  const target = opts.path ?? opts.cwd;
  const cfg = loadConfig(target);
  const cliExcludes = opts.exclude ?? [];
  // Shallow-clone graph + construct a fresh exclude array so we never mutate
  // DEFAULT_CONFIG.graph.exclude (which loadConfig shallow-spreads by reference).
  const effectiveConfig: Config =
    cliExcludes.length === 0
      ? cfg
      : {
          ...cfg,
          graph: {
            ...cfg.graph,
            exclude: [...cfg.graph.exclude, ...cliExcludes],
          },
        };
  const result = await buildGraph({
    cwd: target,
    force: opts.force,
    config: effectiveConfig,
  });
  process.stdout.write(`${stableStringify(result)}\n`);
  return result.ok ? 0 : 1;
};
