import { existsSync, rmSync } from "node:fs";
import { stableStringify } from "../util/json.js";
import { graphDir, tokenomyGraphRootDir } from "../core/paths.js";
import { resolveRepoId } from "../graph/repo-id.js";

export const runGraphPurge = async (opts: {
  cwd: string;
  path?: string;
  all?: boolean;
}): Promise<number> => {
  if (opts.all) {
    rmSync(tokenomyGraphRootDir(), { recursive: true, force: true });
    process.stdout.write(
      `${stableStringify({ ok: true, data: { purged: true, scope: "all" } })}\n`,
    );
    return 0;
  }

  const target = opts.path ?? opts.cwd;
  const { repoId } = resolveRepoId(target);
  const path = graphDir(repoId);
  const existed = existsSync(path);
  rmSync(path, { recursive: true, force: true });
  process.stdout.write(
    `${stableStringify({ ok: true, data: { purged: existed, scope: "repo", repo_id: repoId } })}\n`,
  );
  return 0;
};
