import { stableStringify } from "../util/json.js";
import { buildGraph } from "../graph/build.js";
import { loadConfig } from "../core/config.js";
import { resolveRepoId } from "../graph/repo-id.js";
import type { Config } from "../core/types.js";

export const runGraphBuild = async (opts: {
  cwd: string;
  path?: string;
  force?: boolean;
  exclude?: string[];
}): Promise<number> => {
  const target = opts.path ?? opts.cwd;
  // 0.1.8+ codex round 7: load cfg from resolved repo root so subdir
  // invocations pick up `.tokenomy.json` at the project root.
  const identity = resolveRepoId(target);
  const cfg = loadConfig(identity.repoPath);
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
