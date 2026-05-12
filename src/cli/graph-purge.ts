import { existsSync, rmSync } from "node:fs";
import { stableStringify } from "../util/json.js";
import {
  graphDir,
  legacyGraphRootDir,
} from "../core/paths.js";
import { loadConfig } from "../core/config.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { listProjects } from "../util/projects-registry.js";

export const runGraphPurge = async (opts: {
  cwd: string;
  path?: string;
  all?: boolean;
}): Promise<number> => {
  if (opts.all) {
    // 0.1.8+: walk the project registry and remove every registered repo's
    // `.tokenomy-graph/` (in-repo) or `~/.tokenomy/graphs/<repoId>/` (legacy
    // home mode), then nuke the legacy root if empty. Pre-0.1.8 this just
    // rm -rf'd `~/.tokenomy/graphs/`.
    const purged: string[] = [];
    for (const project of listProjects()) {
      const identity = { repoId: project.repoId, repoPath: project.repoRoot };
      const cfg = loadConfig(project.repoRoot);
      const dir = graphDir(identity, cfg.graph);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        purged.push(dir);
      }
    }
    // Also drop the legacy root if it still exists (covers unmigrated installs).
    const legacy = legacyGraphRootDir();
    if (existsSync(legacy)) {
      rmSync(legacy, { recursive: true, force: true });
      purged.push(legacy);
    }
    process.stdout.write(
      `${stableStringify({ ok: true, data: { purged: purged.length > 0, scope: "all", paths: purged } })}\n`,
    );
    return 0;
  }

  const target = opts.path ?? opts.cwd;
  const identity = resolveRepoId(target);
  // 0.1.8+ codex round 7: load cfg from resolved repo root.
  const cfg = loadConfig(identity.repoPath);
  const path = graphDir(identity, cfg.graph);
  const existed = existsSync(path);
  rmSync(path, { recursive: true, force: true });
  process.stdout.write(
    `${stableStringify({ ok: true, data: { purged: existed, scope: "repo", repo_id: identity.repoId, path } })}\n`,
  );
  return 0;
};
