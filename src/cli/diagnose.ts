import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform, release } from "node:os";
import { TOKENOMY_VERSION } from "../core/version.js";
import { loadConfig } from "../core/config.js";
import {
  feedbackLogPath,
  graphDirtySentinelPath,
  graphBuildLogPath,
  graphMetaPath,
  graphRebuildLockPath,
  graphSnapshotPath,
  ravenRepoDir,
  tokenomyDir,
  updateCachePath,
} from "../core/paths.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { readLastGraphBuildFailure, readLastGraphBuildLog } from "../graph/build-log.js";
import { collectRavenStats } from "../raven/stats.js";
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
    // 0.1.8+ codex round 9: load cfg from resolved repo root.
    let cfgPath = process.cwd();
    try {
      cfgPath = resolveRepoId(process.cwd()).repoPath;
    } catch {
      // not a git repo — fall back to cwd
    }
    const cfg = loadConfig(cfgPath);
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
    const identity = resolveRepoId(process.cwd());
    // 0.1.8+ codex round 9: load cfg from resolved repo root.
    const cfg = loadConfig(identity.repoPath);
    const meta = graphMetaPath(identity, cfg.graph);
    const snapshot = graphSnapshotPath(identity, cfg.graph);
    const buildLog = graphBuildLogPath(identity, cfg.graph);
    const dirty = graphDirtySentinelPath(identity, cfg.graph);
    const lock = graphRebuildLockPath(identity, cfg.graph);
    const built = existsSync(meta) && existsSync(snapshot);
    const lastBuild = readLastGraphBuildLog(identity, cfg.graph);
    const lastFailure = readLastGraphBuildFailure(identity, cfg.graph);
    const out: SectionResult = {
      ok: built,
      repo_id: identity.repoId,
      repo_path: identity.repoPath,
      location: cfg.graph.location ?? "in-repo",
      meta_present: existsSync(meta),
      snapshot_present: existsSync(snapshot),
      build_log_present: existsSync(buildLog),
      dirty_sentinel_present: existsSync(dirty),
      rebuild_in_progress: existsSync(lock),
    };
    if (lastBuild) {
      out.last_build = {
        ts: lastBuild.ts,
        built: lastBuild.built,
        reason: lastBuild.reason,
        hint: lastBuild.hint,
        node_count: lastBuild.node_count,
        edge_count: lastBuild.edge_count,
        parse_error_count: lastBuild.parse_error_count,
        duration_ms: lastBuild.duration_ms,
      };
      if (!built && !lastBuild.built && lastBuild.reason) {
        out.reason = lastBuild.reason;
        if (lastFailure?.hint) out.hint = lastFailure.hint;
      }
    }
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

const sectionRaven = (allRepos = false): SectionResult => {
  try {
    // 0.1.8+: default to cwd-scoped tally; `allRepos:true` uses the
    // collectRavenStats path which walks the project registry +
    // legacy-fallback for unmigrated repos.
    if (allRepos) {
      const stats = collectRavenStats(true);
      return {
        ok: true,
        scope: "all-repos",
        repos: stats.repos,
        packets: stats.packets,
        reviews: stats.reviews,
        comparisons: stats.comparisons,
        decisions: stats.decisions,
        last_activity: stats.last_activity,
      };
    }
    const identity = resolveRepoId(process.cwd());
    // 0.1.8+ codex round 9: load cfg from resolved repo root.
    const cfg = loadConfig(identity.repoPath);
    const root = ravenRepoDir(identity, cfg.raven);
    if (!existsSync(root)) {
      return {
        ok: true,
        scope: "cwd",
        repos: 0,
        root,
        present: false,
        location: cfg.raven.location ?? "in-repo",
      };
    }
    let totalBytes = 0;
    for (const sub of ["packets", "reviews", "comparisons", "decisions"]) {
      const dir = join(root, sub);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        try {
          totalBytes += statSync(join(dir, name)).size;
        } catch {
          // skip
        }
      }
    }
    return {
      ok: true,
      scope: "cwd",
      root,
      repos: 1,
      total_bytes: totalBytes,
      location: cfg.raven.location ?? "in-repo",
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
};

const sectionKratos = (): SectionResult => {
  try {
    // 0.1.8+ codex round 9: load cfg from resolved repo root.
    let cfgPath = process.cwd();
    try {
      cfgPath = resolveRepoId(process.cwd()).repoPath;
    } catch {
      // not a git repo — fall back to cwd
    }
    const cfg = loadConfig(cfgPath);
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
    // 0.1.8+ codex round 9: load cfg from resolved repo root.
    let cfgPath = process.cwd();
    try {
      cfgPath = resolveRepoId(process.cwd()).repoPath;
    } catch {
      // not a git repo — fall back to cwd
    }
    const cfg = loadConfig(cfgPath);
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

export interface BuildDiagnoseOptions {
  // 0.1.8+: when true, dirty-age + raven-size checks (in doctor) and the
  // raven section walk every registered project. Default false (cwd only).
  allRepos?: boolean;
}

export const buildDiagnoseReport = async (
  opts: BuildDiagnoseOptions = {},
): Promise<DiagnoseReport> => {
  // 0.1.5+: never let runDoctor's failure abort the whole report. If it
  // throws, surface a `doctor: { ok: false, reason }` block and force
  // `worst: "error"`. Codex audit catch.
  let doctor: SectionResult;
  try {
    const doctorChecks = await runDoctor({ allRepos: opts.allRepos });
    const failures = doctorChecks.filter((c) => !c.ok);
    doctor = {
      ok: failures.length === 0,
      total: doctorChecks.length,
      failed: failures.length,
      failed_names: failures.map((f) => f.name),
    };
  } catch (e) {
    doctor = { ok: false, reason: (e as Error).message };
  }
  const sections = {
    graph: sectionGraph(),
    raven: sectionRaven(opts.allRepos),
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
  const allRepos = argv.includes("--all-repos");
  const report = await buildDiagnoseReport({ allRepos });
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
