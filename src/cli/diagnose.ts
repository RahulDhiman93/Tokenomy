import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, release } from "node:os";
import { TOKENOMY_VERSION } from "../core/version.js";
import { loadConfig } from "../core/config.js";
import {
  feedbackLogPath,
  graphDirtySentinelPath,
  graphMetaPath,
  graphRebuildLockPath,
  graphSnapshotPath,
  ravenRootDir,
  tokenomyDir,
  updateCachePath,
} from "../core/paths.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { commandExists } from "./agents/common.js";
import { runDoctor } from "./doctor.js";

// `tokenomy diagnose` — one-shot JSON health report.
//
// Designed for the user to copy + paste into `tokenomy feedback` when
// something looks wrong. Covers every feature in 0.1.x (live trim,
// graph, raven, kratos, golem, statusline, update cache) plus environment
// metadata. Read-only. Never throws — every section that fails contributes
// `{ ok: false, reason: "..." }` and the rest still emit.
//
// Output shape: stable, deterministic, JSON. No prose, no ANSI colors.

interface SectionResult {
  ok: boolean;
  [k: string]: unknown;
}

interface DiagnoseReport {
  schema_version: 1;
  generated_at: string;
  tokenomy: {
    version: string;
    bin: string;
    home_dir: string;
  };
  env: {
    platform: string;
    os_release: string;
    node: string;
    arch: string;
    cwd: string;
    home: string;
  };
  agents: { name: string; on_path: boolean }[];
  doctor: SectionResult;
  graph: SectionResult;
  raven: SectionResult;
  kratos: SectionResult;
  golem: SectionResult;
  update: SectionResult;
  feedback_log: SectionResult;
  config: SectionResult;
  // Highest severity from doctor + per-section ok flags. "ok" when every
  // section is ok; "warning" when any non-doctor section is not ok;
  // "error" when doctor reports any failed check.
  worst: "ok" | "warning" | "error";
}

const sectionTokenomy = () => ({
  version: TOKENOMY_VERSION,
  bin: process.argv[1] ?? "(unknown)",
  home_dir: tokenomyDir(),
});

const sectionEnv = () => ({
  platform: platform(),
  os_release: release(),
  node: process.version,
  arch: process.arch,
  cwd: process.cwd(),
  home: homedir(),
});

const sectionAgents = () =>
  ["claude", "codex", "cursor", "windsurf", "cline", "gemini"].map((name) => ({
    name,
    on_path: commandExists(name),
  }));

const sectionConfig = (): SectionResult => {
  try {
    const cfg = loadConfig(process.cwd());
    return {
      ok: true,
      log_path: cfg.log_path,
      golem_enabled: cfg.golem.enabled,
      golem_mode: cfg.golem.mode,
      raven_enabled: cfg.raven.enabled,
      kratos_enabled: cfg.kratos.enabled,
      kratos_continuous: cfg.kratos.continuous,
      graph_enabled: cfg.graph.enabled,
      graph_async_rebuild: cfg.graph.async_rebuild ?? true,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

const sectionGraph = (): SectionResult => {
  try {
    const { repoId, repoPath } = resolveRepoId(process.cwd());
    const meta = graphMetaPath(repoId);
    const snapshot = graphSnapshotPath(repoId);
    const dirty = graphDirtySentinelPath(repoId);
    const lock = graphRebuildLockPath(repoId);
    const built = existsSync(meta) && existsSync(snapshot);
    const out: SectionResult = {
      ok: built,
      repo_id: repoId,
      repo_path: repoPath,
      meta_present: existsSync(meta),
      snapshot_present: existsSync(snapshot),
      dirty_sentinel_present: existsSync(dirty),
      rebuild_in_progress: existsSync(lock),
    };
    if (existsSync(snapshot)) {
      try {
        const st = statSync(snapshot);
        out.snapshot_bytes = st.size;
        out.built_at = new Date(st.mtimeMs).toISOString();
        out.age_ms = Date.now() - st.mtimeMs;
      } catch {
        // skip
      }
    }
    return out;
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

const sectionRaven = (): SectionResult => {
  try {
    const root = ravenRootDir();
    if (!existsSync(root)) return { ok: true, repos: 0, root, present: false };
    const repos = readdirSync(root).filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    });
    let totalBytes = 0;
    for (const repo of repos) {
      const repoDir = join(root, repo);
      for (const sub of ["packets", "reviews", "comparisons", "decisions"]) {
        const dir = join(repoDir, sub);
        if (!existsSync(dir)) continue;
        for (const name of readdirSync(dir)) {
          try {
            totalBytes += statSync(join(dir, name)).size;
          } catch {
            // skip
          }
        }
      }
    }
    return { ok: true, root, repos: repos.length, total_bytes: totalBytes };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

const sectionKratos = (): SectionResult => {
  try {
    const cfg = loadConfig(process.cwd());
    return {
      ok: true,
      enabled: cfg.kratos.enabled,
      continuous: cfg.kratos.continuous,
      prompt_min_severity: cfg.kratos.prompt_min_severity,
      categories: cfg.kratos.categories,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

const sectionGolem = (): SectionResult => {
  try {
    const cfg = loadConfig(process.cwd());
    return {
      ok: true,
      enabled: cfg.golem.enabled,
      mode: cfg.golem.mode,
      safety_gates: cfg.golem.safety_gates,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

const sectionUpdate = (): SectionResult => {
  const path = updateCachePath();
  if (!existsSync(path)) return { ok: true, present: false };
  try {
    const st = statSync(path);
    const ageMs = Date.now() - st.mtimeMs;
    return {
      ok: true,
      present: true,
      path,
      bytes: st.size,
      age_ms: ageMs,
      stale: ageMs > 24 * 60 * 60 * 1000,
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

const sectionFeedback = (): SectionResult => {
  const path = feedbackLogPath();
  if (!existsSync(path)) return { ok: true, present: false };
  try {
    const st = statSync(path);
    return { ok: true, present: true, path, bytes: st.size };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

export const buildDiagnoseReport = async (): Promise<DiagnoseReport> => {
  const doctorChecks = await runDoctor();
  const failures = doctorChecks.filter((c) => !c.ok);
  const doctor: SectionResult = {
    ok: failures.length === 0,
    total: doctorChecks.length,
    failed: failures.length,
    failed_names: failures.map((f) => f.name),
  };
  const sections = {
    graph: sectionGraph(),
    raven: sectionRaven(),
    kratos: sectionKratos(),
    golem: sectionGolem(),
    update: sectionUpdate(),
    feedback_log: sectionFeedback(),
    config: sectionConfig(),
  };
  const sectionFailures = Object.values(sections).filter((s) => s.ok === false).length;
  const worst: DiagnoseReport["worst"] =
    !doctor.ok ? "error" : sectionFailures > 0 ? "warning" : "ok";

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    tokenomy: sectionTokenomy(),
    env: sectionEnv(),
    agents: sectionAgents(),
    doctor,
    ...sections,
    worst,
  };
};

export const runDiagnose = async (argv: string[]): Promise<number> => {
  const json = argv.includes("--json");
  const report = await buildDiagnoseReport();
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    // Default human-readable: still mostly JSON for `tokenomy feedback`
    // copy-paste, but with a brief header.
    process.stdout.write(`tokenomy diagnose @ ${report.generated_at}\n`);
    process.stdout.write(
      `  version=${report.tokenomy.version}  worst=${report.worst}  doctor=${report.doctor.failed === 0 ? "ok" : `${report.doctor.failed}/${report.doctor.total} failed`}\n`,
    );
    process.stdout.write("\n");
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  }
  return report.worst === "error" ? 1 : 0;
};
