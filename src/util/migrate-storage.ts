import { cpSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, basename } from "node:path";
import {
  graphDir,
  legacyGraphRootDir,
  legacyRavenRootDir,
  ravenRepoDir,
  type RepoIdentityLike,
} from "../core/paths.js";
import { listProjects } from "./projects-registry.js";
import { join } from "node:path";

// 0.1.8+: storage relocation helper. Moves a single repo's legacy
// `~/.tokenomy/{graphs,raven}/<repoId>/` into the new in-repo location
// `<repoRoot>/.tokenomy-{graph,raven}/`.
//
// - Atomic rename when src + dst are on the same fs; copy-then-delete
//   otherwise.
// - No-op when src doesn't exist OR dst already exists (preserves any
//   user-staged work in the new location).
// - Best-effort: any IO failure returns `{ ok: false, reason }` and the
//   legacy dir is left untouched. Callers fall back to "build fresh"
//   without data loss.

export type MigrateKind = "graph" | "raven";

export interface MigrateResult {
  kind: MigrateKind;
  from: string;
  to: string;
  status: "moved" | "skipped-no-src" | "skipped-dst-exists" | "failed";
  reason?: string;
}

const legacyDirFor = (kind: MigrateKind, repoId: string): string =>
  kind === "graph"
    ? join(legacyGraphRootDir(), repoId)
    : join(legacyRavenRootDir(), repoId);

const inRepoDirFor = (kind: MigrateKind, identity: RepoIdentityLike): string =>
  kind === "graph"
    ? graphDir(identity, { location: "in-repo" })
    : ravenRepoDir(identity, { location: "in-repo" });

const moveDir = (src: string, dst: string): { ok: boolean; reason?: string } => {
  try {
    renameSync(src, dst);
    return { ok: true };
  } catch {
    // 0.1.8+ codex round 1: cross-fs rename fallback. Copy to a temp
    // sibling of `dst` first, then atomic-rename into place. If the copy
    // fails midway we delete the temp; the user never sees a partial
    // `.tokenomy-graph/` dir. Legacy src is only removed AFTER the
    // rename succeeds.
    const tempDst = `${dst}.migrating-${process.pid}-${Date.now()}`;
    try {
      cpSync(src, tempDst, { recursive: true });
    } catch (e) {
      try {
        rmSync(tempDst, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      return { ok: false, reason: (e as Error).message };
    }
    try {
      renameSync(tempDst, dst);
    } catch (e) {
      // Final rename failed — purge temp; do NOT remove legacy src.
      try {
        rmSync(tempDst, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      return { ok: false, reason: (e as Error).message };
    }
    try {
      rmSync(src, { recursive: true, force: true });
    } catch {
      // best-effort: dst is good; legacy lingering is harmless (will be
      // skipped as `skipped-dst-exists` on subsequent migration attempts).
    }
    return { ok: true };
  }
};

// 0.1.8+: try to relocate one repo's legacy storage. Returns the action
// taken so callers can log + count.
export const tryMigrateOne = (
  kind: MigrateKind,
  identity: RepoIdentityLike,
): MigrateResult => {
  const from = legacyDirFor(kind, identity.repoId);
  const to = inRepoDirFor(kind, identity);
  if (!existsSync(from)) {
    return { kind, from, to, status: "skipped-no-src" };
  }
  if (existsSync(to)) {
    return { kind, from, to, status: "skipped-dst-exists" };
  }
  try {
    const st = statSync(from);
    if (!st.isDirectory()) {
      return { kind, from, to, status: "failed", reason: "src is not a directory" };
    }
  } catch (e) {
    return { kind, from, to, status: "failed", reason: (e as Error).message };
  }
  const moved = moveDir(from, to);
  if (!moved.ok) return { kind, from, to, status: "failed", reason: moved.reason };
  return { kind, from, to, status: "moved" };
};

// 0.1.8+: walk the project registry and migrate every project's storage of
// the given kind. Used by `tokenomy {graph,raven} migrate [--apply]`.
//
// `apply: false` (dry-run default) returns the planned actions without
// touching disk. `apply: true` performs the moves.
export const migrateAll = (
  kind: MigrateKind,
  apply: boolean,
): MigrateResult[] => {
  const out: MigrateResult[] = [];
  for (const project of listProjects()) {
    const identity = { repoId: project.repoId, repoPath: project.repoRoot };
    if (apply) {
      out.push(tryMigrateOne(kind, identity));
    } else {
      const from = legacyDirFor(kind, identity.repoId);
      const to = inRepoDirFor(kind, identity);
      if (!existsSync(from)) {
        out.push({ kind, from, to, status: "skipped-no-src" });
      } else if (existsSync(to)) {
        out.push({ kind, from, to, status: "skipped-dst-exists" });
      } else {
        out.push({ kind, from, to, status: "moved" });
      }
    }
  }
  return out;
};
