import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../core/config.js";
import { globalConfigPath } from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { backupFile } from "../util/backup.js";
import { safeParse, stableStringify } from "../util/json.js";
import { appendGitignoreLine } from "../util/gitignore.js";
import { registerProject } from "../util/projects-registry.js";
import { migrateAll, tryMigrateOne } from "../util/migrate-storage.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { commandExists } from "./agents/common.js";
import { runInit } from "./init.js";
import { createAndSaveRavenPacket } from "../raven/brief.js";
import { compareReviews } from "../raven/compare.js";
import { collectGitState } from "../raven/git.js";
import { getPrReadiness } from "../raven/pr-check.js";
import { renderReadinessMarkdown } from "../raven/render.js";
import { cleanStore, ensureRavenStore, listReviews, readLatestPacket, ravenStoreForRepo } from "../raven/store.js";

const HELP = `Usage:
  tokenomy raven enable
  tokenomy raven disable [--purge]
  tokenomy raven status
  tokenomy raven brief [--goal=<text>] [--target=claude-code|codex|human] [--json]
  tokenomy raven compare [--json]
  tokenomy raven pr-check [--json]
  tokenomy raven clean [--dry-run] [--keep=<N>] [--older-than=<days>]
  tokenomy raven migrate [--apply]
  tokenomy raven install-commands
`;

const readGlobal = (): Record<string, unknown> => {
  if (!existsSync(globalConfigPath())) return {};
  return safeParse<Record<string, unknown>>(readFileSync(globalConfigPath(), "utf8")) ?? {};
};

const writeGlobal = (cfg: Record<string, unknown>): string | null => {
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  const backup = backupFile(globalConfigPath());
  atomicWrite(globalConfigPath(), stableStringify(cfg) + "\n", false);
  return backup;
};

const setRavenEnabled = (enabled: boolean): string | null => {
  const cfg = readGlobal();
  const raven =
    cfg.raven && typeof cfg.raven === "object" && !Array.isArray(cfg.raven)
      ? { ...(cfg.raven as Record<string, unknown>) }
      : {};
  raven.enabled = enabled;
  cfg.raven = raven;
  return writeGlobal(cfg);
};

const parseFlag = (argv: string[], name: string): string | undefined => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 ? argv[idx + 1] : undefined;
};

// 0.1.8+: resolve {git, store} together. Storage cfg flows through so the
// store dir matches the configured location (in-repo vs home).
const repoStore = (cwd: string) => {
  const cfg = loadConfig(cwd);
  const git = collectGitState(cwd);
  if (!git.ok) return git;
  const identity = { repoId: git.data.repo_id, repoPath: git.data.root };
  return {
    ok: true as const,
    data: { git: git.data, store: ravenStoreForRepo(identity, cfg.raven), identity },
  };
};

const runEnable = (): number => {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const codexFound = commandExists("codex");
  if (cfg.raven.requires_codex && !codexFound) {
    process.stderr.write(
      "✗ Raven cannot be enabled\n" +
        "  codex cli not found on PATH\n\n" +
        "Install Codex CLI first:\n" +
        "  npm i -g @openai/codex\n\n" +
        "Then run:\n" +
        "  tokenomy raven enable\n",
    );
    return 1;
  }
  const init = runInit({ graphPath: cwd, backup: true });
  const backup = setRavenEnabled(true);
  // 0.1.8+: auto-migrate legacy ~/.tokenomy/raven/<repoId>/ to in-repo
  // BEFORE we create the new store. Best-effort.
  let migrated: { from: string; to: string } | null = null;
  if (
    (cfg.raven.location ?? "in-repo") === "in-repo" &&
    cfg.raven.auto_migrate !== false
  ) {
    try {
      const identity = resolveRepoId(cwd);
      const r = tryMigrateOne("raven", identity);
      if (r.status === "moved") migrated = { from: r.from, to: r.to };
    } catch {
      // best-effort
    }
  }
  const store = repoStore(cwd);
  if (store.ok) {
    ensureRavenStore(store.data.store);
    // 0.1.8+: in-repo storage → patch `.gitignore` + register project.
    if (
      (cfg.raven.location ?? "in-repo") === "in-repo" &&
      cfg.raven.auto_gitignore !== false
    ) {
      appendGitignoreLine(join(store.data.identity.repoPath, ".gitignore"), ".tokenomy-raven/");
    }
    try {
      registerProject({
        repoRoot: store.data.identity.repoPath,
        repoId: store.data.identity.repoId,
        raven_enabled: true,
      });
    } catch {
      // best-effort
    }
  }
  process.stdout.write(
    [
      "✓ Raven enabled",
      `  codex:  ${codexFound ? "found" : "not required"}`,
      `  mcp:    tokenomy-graph registered`,
      `  store:  ${store.ok ? store.data.store.dir : "(not a git repo)"}`,
      ...(migrated ? [`  migrated: ${migrated.from} → ${migrated.to}`] : []),
      `  config: ${globalConfigPath()}`,
      `  backup: ${backup ?? "(none)"}`,
      `  hook:   ${init.hookPath ?? "(not installed)"}`,
      "  Restart Claude Code so Raven session guidance loads cleanly.",
      "",
    ].join("\n"),
  );
  return 0;
};

const runDisable = (argv: string[]): number => {
  const backup = setRavenEnabled(false);
  if (argv.includes("--purge")) {
    const store = repoStore(process.cwd());
    if (store.ok && existsSync(store.data.store.dir)) {
      rmSync(store.data.store.dir, { recursive: true, force: true });
    }
  }
  process.stdout.write(`✓ Raven disabled\n  backup: ${backup ?? "(none)"}\n`);
  return 0;
};

// 0.1.8+: dry-run + apply raven migration across every registered project.
// Mirrors `tokenomy graph migrate`.
const runMigrate = (argv: string[]): number => {
  const apply = argv.includes("--apply");
  const results = migrateAll("raven", apply);
  if (results.length === 0) {
    process.stdout.write("No projects registered. Run `tokenomy raven enable` in each repo first, then retry.\n");
    return 0;
  }
  let moved = 0;
  let skipped = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "moved") moved++;
    else if (r.status === "failed") failed++;
    else skipped++;
    process.stdout.write(`  ${r.status.padEnd(20)} ${r.from} → ${r.to}${r.reason ? ` (${r.reason})` : ""}\n`);
  }
  process.stdout.write(
    `\n${apply ? "Migrated" : "Would migrate"}: ${moved} moved, ${skipped} skipped, ${failed} failed.\n`,
  );
  if (!apply) process.stdout.write("Re-run with --apply to perform the moves.\n");
  return failed > 0 ? 1 : 0;
};

const runStatus = (): number => {
  const cfg = loadConfig(process.cwd());
  const store = repoStore(process.cwd());
  if (!store.ok) {
    process.stdout.write(`Raven: ${cfg.raven.enabled ? "enabled" : "disabled"}\nRepo: ${store.reason}\n`);
    return 0;
  }
  const packet = readLatestPacket(store.data.store);
  process.stdout.write(
    [
      `Raven: ${cfg.raven.enabled ? "enabled" : "disabled"}`,
      `Codex: ${commandExists("codex") ? "found" : "not found"}`,
      `Store: ${store.data.store.dir}`,
      `Latest packet: ${packet ? `${packet.packet_id} @ ${packet.repo.head_sha.slice(0, 8)}` : "(none)"}`,
      `Reviews: ${packet ? listReviews(store.data.store, packet.packet_id).length : 0}`,
      "",
    ].join("\n"),
  );
  return 0;
};

const runBrief = (argv: string[]): number => {
  const json = argv.includes("--json");
  const result = createAndSaveRavenPacket({
    cwd: process.cwd(),
    goal: parseFlag(argv, "goal"),
    targetAgent: parseFlag(argv, "target") as "claude-code" | "codex" | "human" | undefined,
    intent: "review",
    sourceAgent: "human",
  });
  if (!result.ok) {
    process.stderr.write(`tokenomy raven brief: ${result.reason}${result.hint ? ` — ${result.hint}` : ""}\n`);
    return 1;
  }
  if (json) process.stdout.write(JSON.stringify(result.data.packet, null, 2) + "\n");
  else {
    process.stdout.write(result.data.markdown);
    process.stdout.write(`\n✓ Raven packet written to ${result.data.path}\n`);
  }
  return 0;
};

const runCompare = (argv: string[]): number => {
  const store = repoStore(process.cwd());
  if (!store.ok) {
    process.stderr.write(`tokenomy raven compare: ${store.reason}\n`);
    return 1;
  }
  const packet = readLatestPacket(store.data.store);
  if (!packet) {
    process.stderr.write("tokenomy raven compare: no Raven packet found. Run `tokenomy raven brief` first.\n");
    return 1;
  }
  const reviews = listReviews(store.data.store, packet.packet_id);
  const cmp = compareReviews(packet, store.data.git.root, store.data.store, reviews);
  if (!cmp.ok) {
    process.stderr.write(`tokenomy raven compare: ${cmp.reason}${cmp.hint ? ` — ${cmp.hint}` : ""}\n`);
    return 1;
  }
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(cmp.data, null, 2) + "\n");
  else process.stdout.write(`✓ Raven comparison: ${cmp.data.recommended_action}\n`);
  return 0;
};

const runPrCheck = (argv: string[]): number => {
  const store = repoStore(process.cwd());
  if (!store.ok) {
    process.stderr.write(`tokenomy raven pr-check: ${store.reason}\n`);
    return 1;
  }
  const packet = readLatestPacket(store.data.store);
  if (!packet) {
    process.stderr.write("tokenomy raven pr-check: no Raven packet found. Run `tokenomy raven brief` first.\n");
    return 1;
  }
  const readiness = getPrReadiness(packet, store.data.git.root, store.data.store, listReviews(store.data.store, packet.packet_id));
  if (!readiness.ok) {
    process.stderr.write(`tokenomy raven pr-check: ${readiness.reason}\n`);
    return 1;
  }
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(readiness.data, null, 2) + "\n");
  else process.stdout.write(renderReadinessMarkdown(readiness.data));
  return readiness.data.ready === "no" ? 2 : 0;
};

const runClean = (argv: string[]): number => {
  const store = repoStore(process.cwd());
  if (!store.ok) {
    process.stderr.write(`tokenomy raven clean: ${store.reason}\n`);
    return 1;
  }
  const cfg = loadConfig(process.cwd());
  const keep = parseInt(parseFlag(argv, "keep") ?? `${cfg.raven.clean_keep}`, 10);
  const olderRaw = parseFlag(argv, "older-than") ?? `${cfg.raven.clean_older_than_days}`;
  const older = parseInt(olderRaw.replace(/d$/, ""), 10);
  const result = cleanStore(store.data.store, {
    keep: Number.isFinite(keep) ? keep : cfg.raven.clean_keep,
    olderThanDays: Number.isFinite(older) ? older : cfg.raven.clean_older_than_days,
    dryRun: argv.includes("--dry-run"),
  });
  if (!result.ok) {
    process.stderr.write(`tokenomy raven clean: ${result.reason}\n`);
    return 1;
  }
  process.stdout.write(`${argv.includes("--dry-run") ? "Would remove" : "Removed"} ${result.data.removed.length} Raven artifact(s).\n`);
  return 0;
};

const runInstallCommands = (): number => {
  const dir = join(process.cwd(), ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  const files = [
    {
      name: "raven-brief.md",
      body: "---\ndescription: Create a Tokenomy Raven handoff packet\n---\n\nRun `tokenomy raven brief` and use the resulting packet before broad review reads.\n",
    },
    {
      name: "raven-pr-check.md",
      body: "---\ndescription: Check PR readiness using Tokenomy Raven\n---\n\nRun `tokenomy raven pr-check` and address any blocking findings before merge.\n",
    },
  ];
  for (const f of files) {
    const path = join(dir, f.name);
    if (existsSync(path)) {
      process.stderr.write(`tokenomy raven install-commands: ${path} already exists; not clobbering.\n`);
      return 1;
    }
  }
  for (const f of files) writeFileSync(join(dir, f.name), f.body, "utf8");
  process.stdout.write(`✓ Raven Claude commands installed in ${dir}\n`);
  return 0;
};

export const runRaven = (argv: string[]): number => {
  const sub = argv[0];
  if (sub === "enable") return runEnable();
  if (sub === "disable") return runDisable(argv.slice(1));
  if (sub === "status") return runStatus();
  if (sub === "brief") return runBrief(argv.slice(1));
  if (sub === "compare") return runCompare(argv.slice(1));
  if (sub === "pr-check") return runPrCheck(argv.slice(1));
  if (sub === "clean") return runClean(argv.slice(1));
  if (sub === "migrate") return runMigrate(argv.slice(1));
  if (sub === "install-commands") return runInstallCommands();
  process.stderr.write(HELP);
  return 1;
};
