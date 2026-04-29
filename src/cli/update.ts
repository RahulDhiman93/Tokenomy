import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKENOMY_VERSION } from "../core/version.js";
import { updateCachePath } from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { stableStringify } from "../util/json.js";
import { getClaudeMcpServer } from "../util/claude-user-config.js";

// Cache the most recent registry lookup so the statusline can render an
// update-available marker without making a blocking network call on every
// render. Only written for dist-tag lookups (not pinned versions), since a
// pinned `--version=X` isn't meaningful as "latest on npm".
export const writeUpdateCache = (remote: string, tag: string): void => {
  try {
    const path = updateCachePath();
    mkdirSync(dirname(path), { recursive: true });
    atomicWrite(
      path,
      stableStringify({ installed: TOKENOMY_VERSION, remote, tag, fetched_at: new Date().toISOString() }) + "\n",
      false,
    );
  } catch {
    // Cache write failures must never break `update --check`.
  }
};

// Read the previously-registered graph path so `tokenomy update` can restage
// the graph MCP server for the user without making them remember their path.
// Returns null when no graph is registered, when the registered entry is
// malformed, or when the directory no longer exists on disk.
const previouslyRegisteredGraphPath = (): string | null => {
  const entry = getClaudeMcpServer("tokenomy-graph") as
    | { command?: unknown; args?: unknown }
    | undefined;
  if (!entry || entry.command !== "tokenomy" || !Array.isArray(entry.args)) return null;
  const args = entry.args as string[];
  const pathIdx = args.indexOf("--path");
  if (pathIdx === -1 || pathIdx + 1 >= args.length) return null;
  const path = args[pathIdx + 1];
  if (typeof path !== "string" || path.length === 0) return null;
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) return null;
  } catch {
    return null;
  }
  return path;
};

// `tokenomy update` — self-update command.
//
// The core primitive is `npm install -g tokenomy@<target>`, but doing that
// alone leaves the staged hook under `~/.tokenomy/bin/dist/` stale (it's a
// frozen copy taken at init time). After the npm install completes, we
// re-run init() to copy the fresh dist/. Users get a one-command update
// without having to remember the re-init step.
//
// Also supports `--check` mode: queries the npm registry for the version
// tagged against the given dist-tag, prints installed vs remote, and
// exits non-zero when an update is available. Useful in scripts / CI and
// for a future "nudge on doctor" follow-up that shouldn't block on install.

export interface UpdateOptions {
  // One of: "latest" | "alpha" | "beta" | "rc". Defaults to "alpha" while
  // this package is pre-1.0 (since every live release ships under `alpha`).
  tag?: string;
  // Pin an exact version — takes precedence over tag when both are set.
  version?: string;
  // Query the registry, print status, exit 0 / 1, but don't install.
  check?: boolean;
  // Override the dev-symlink guard (see isDevSymlink()). Use at own risk:
  // the `npm install -g` will replace your linked dev checkout.
  force?: boolean;
  // 0.1.3+: silence stdout/stderr when triggered by SessionStart /
  // statusline. The cache write is the side effect that matters; the
  // human-readable lines are noise in those code paths.
  quiet?: boolean;
}

const runNpm = (
  args: string[],
  inherit = false,
  timeoutMs?: number,
): { status: number; stdout: string; stderr: string } => {
  const r = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
};

// Query the npm registry for the version currently tagged `<tag>`.
// Returns null if the network call fails or npm isn't on PATH — callers
// treat that as "can't determine" and fail open.
//
// 0.1.5+: 5s timeout per attempt, 1× retry on transient failure (status
// nonzero with empty stderr — npm's signal for connection-refused or
// dropped DNS). A second hard-fail returns null without further retries
// so SessionStart spawns can't pile up retries on flaky networks.
export const fetchRegistryVersion = (tag: string): string | null => {
  const TIMEOUT_MS = 5_000;
  const attempt = (): string | null => {
    const r = runNpm(["view", `tokenomy@${tag}`, "version"], false, TIMEOUT_MS);
    if (r.status !== 0) return null;
    const v = r.stdout.trim();
    return v.length > 0 ? v : null;
  };
  const first = attempt();
  if (first !== null) return first;
  // Retry once. Conservative — only worth it because npm view can hit a
  // transient DNS or 5xx that resolves immediately on a second try.
  return attempt();
};

// Heuristic: are we running from an `npm link`-style dev checkout?
// A proper `npm install -g` lands the package under
//   <npm-global>/lib/node_modules/tokenomy/dist/cli/update.js
// and the realpath stays inside that tree. An `npm link` keeps the bin
// as a symlink but the realpath points back at the developer's repo,
// which does NOT contain `node_modules/tokenomy/` in its path. That's
// the signal we use.
export const isDevSymlink = (): boolean => {
  try {
    const here = fileURLToPath(import.meta.url);
    const resolved = realpathSync(here);
    const inNodeModules = resolved.includes(`${sep}node_modules${sep}tokenomy${sep}`);
    return !inNodeModules;
  } catch {
    return false;
  }
};

// Prefer `latest` because the current release workflow publishes every
// alpha under `--tag latest`. The `alpha` dist-tag exists but is manually
// maintained and often lags the real latest. Falling back to `alpha` only
// when the running build's own version string lives in the alpha range
// AND `latest` hasn't been set.
const defaultTag = (): string => "latest";

// SemVer-style version comparison. Returns >0 when a > b, <0 when a < b,
// 0 when equal. Follows semver.org precedence rules (§11):
//   1. Main version components compared numerically left-to-right.
//   2. A version with prerelease is LOWER than the same main without one.
//   3. Prerelease identifiers compared dot-separated:
//      - Numeric identifiers compared numerically.
//      - Alphanumeric identifiers compared lexically (ASCII order).
//      - Numeric identifiers always rank below alphanumeric ones.
//      - If one side runs out of identifiers, the longer side wins.
//
// Examples the earlier [numeric-only] implementation got wrong:
//   0.1.0-alpha.12 vs 0.1.0-beta.1 → beta.1 is newer (lexical "alpha"<"beta")
//   0.1.0 vs 0.1.0-rc.1            → 0.1.0 is newer (no prerelease > with)
// Non-numeric identifiers now compare as strings, so beta/rc/alpha order
// like a user expects.
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string): { main: number[]; pre: string[] } => {
    // Strip build metadata after `+` (ignored for precedence per semver).
    const stripped = v.split("+", 1)[0] ?? v;
    const [mainStr, preStr] = stripped.split("-", 2) as [string, string | undefined];
    const main = mainStr
      .split(".")
      .map((x) => Number(x))
      .map((x) => (Number.isFinite(x) ? x : 0));
    const pre = preStr && preStr.length > 0 ? preStr.split(".") : [];
    return { main, pre };
  };
  const aP = parse(a);
  const bP = parse(b);

  // 1. Main version components.
  for (let i = 0; i < Math.max(aP.main.length, bP.main.length); i++) {
    const diff = (aP.main[i] ?? 0) - (bP.main[i] ?? 0);
    if (diff !== 0) return diff;
  }

  // 2. Presence of prerelease lowers precedence.
  if (aP.pre.length === 0 && bP.pre.length > 0) return 1;
  if (aP.pre.length > 0 && bP.pre.length === 0) return -1;

  // 3. Identifier-by-identifier comparison.
  for (let i = 0; i < Math.max(aP.pre.length, bP.pre.length); i++) {
    const ai = aP.pre[i];
    const bi = bP.pre[i];
    // A shorter prerelease list ranks lower than a longer equal-prefix one.
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff;
      continue;
    }
    // Numeric identifiers rank lower than alphanumeric ones.
    if (aNum && !bNum) return -1;
    if (!aNum && bNum) return 1;
    // Both alphanumeric — lexical ASCII.
    if (ai !== bi) return ai < bi ? -1 : 1;
  }
  return 0;
};

export const runUpdate = async (opts: UpdateOptions): Promise<number> => {
  const installed = TOKENOMY_VERSION;
  const tag = opts.tag ?? defaultTag();
  const target = opts.version ?? tag;

  if (opts.check) {
    // 0.1.3+: --quiet silences user-facing prints (used by SessionStart /
    // statusline auto-spawn). Cache write still happens — that's the
    // side effect we actually need.
    const writeOut = opts.quiet ? () => {} : (s: string) => process.stdout.write(s);
    const writeErr = opts.quiet ? () => {} : (s: string) => process.stderr.write(s);
    // Honor an explicit pin: if the user passed --version=X or the
    // update@X shorthand, check resolves against THAT version — not the
    // default tag. A pinned target like `0.1.0-alpha.13` asks the registry
    // directly; npm resolves it to the version itself (or fails if the
    // version doesn't exist on the registry).
    const resolved = fetchRegistryVersion(target);
    if (resolved === null) {
      writeErr(
        `tokenomy update: could not query npm registry for tokenomy@${target}. ` +
          `Is npm on PATH, is the network reachable, and does that version exist?\n`,
      );
      return 2;
    }
    // The right-hand column labels what we actually queried: a dist-tag
    // (e.g. `latest on npm`) vs a pinned version (`pin 0.1.0-alpha.13`).
    const isPinnedVersion = opts.version !== undefined;
    const label = isPinnedVersion ? `pin ${target}` : `${target} on npm`;
    writeOut(`  installed:       ${installed}\n`);
    writeOut(`  ${label.padEnd(16)}: ${resolved}\n`);
    const cmp = compareVersions(resolved, installed);
    // Cache the registry reply so the statusline can render an ↑ marker.
    // Skip pinned-version checks — those aren't meaningful as "latest".
    if (!isPinnedVersion) writeUpdateCache(resolved, target);
    if (cmp === 0) {
      writeOut(`  ✓ Up to date\n`);
      return 0;
    }
    if (cmp < 0) {
      writeOut(
        isPinnedVersion
          ? `  ✓ Installed is newer than the pinned target.\n`
          : `  ✓ Up to date (installed is newer than the \`${target}\` dist-tag on npm).\n`,
      );
      return 0;
    }
    // Suggest the exact command that would perform the upgrade the user
    // just asked about — preserve the pin / tag so they don't accidentally
    // jump to a different release.
    const suggest = isPinnedVersion
      ? `tokenomy update --version=${target}`
      : opts.tag && opts.tag !== defaultTag()
      ? `tokenomy update --tag=${target}`
      : `tokenomy update`;
    writeOut(`  ⚠ Update available. Run \`${suggest}\`.\n`);
    return 1;
  }

  if (isDevSymlink() && !opts.force) {
    process.stderr.write(
      "tokenomy update: this install looks like an `npm link` dev checkout.\n" +
        "  Running `npm install -g` would replace the symlink with the\n" +
        "  published package and lose your local edits. Use `git pull &&\n" +
        "  npm run build` instead, or re-run with --force to override.\n",
    );
    return 1;
  }

  // Downgrade guard. If the target resolves to a lower version than the
  // one installed — typically from an out-of-date dist-tag like `alpha`
  // trailing `latest` — refuse unless --force. With --force, still warn
  // loudly so the downgrade isn't silent.
  const resolved = fetchRegistryVersion(target);
  if (resolved && compareVersions(resolved, installed) < 0) {
    if (!opts.force) {
      process.stderr.write(
        `tokenomy update: target tokenomy@${target} resolves to ${resolved}, ` +
          `which is older than the currently installed ${installed}.\n` +
          `  Refusing to downgrade. Pass --force to override, or use\n` +
          `  --version=${installed} to pin the currently-installed release.\n`,
      );
      return 1;
    }
    process.stderr.write(
      `⚠  tokenomy update: --force downgrade from ${installed} to ${resolved} via tag \`${target}\`.\n`,
    );
  }

  process.stdout.write(`Installing tokenomy@${target} globally…\n`);
  const install = runNpm(["install", "-g", `tokenomy@${target}`], true);
  if (install.status !== 0) {
    process.stderr.write(
      `tokenomy update: \`npm install -g tokenomy@${target}\` exited ${install.status}.\n`,
    );
    return install.status;
  }

  // Restage hook so the fresh dist/ under ~/.tokenomy/bin/dist/ reflects
  // the newly-installed version. We call runInit() from the *new* install
  // via a separate node invocation so we don't stage a stale in-memory
  // dist from the old process.
  //
  // If the user previously registered `tokenomy-graph` (detectable via
  // ~/.claude.json), forward the same --graph-path to `tokenomy init` so
  // the MCP registration stays in sync and the graph is refreshed under
  // the new binary's schema. Skipped silently when no graph is registered.
  const existingGraphPath = previouslyRegisteredGraphPath();
  const initArgs = existingGraphPath
    ? ["init", `--graph-path=${existingGraphPath}`]
    : ["init"];
  process.stdout.write(
    existingGraphPath
      ? `\nRe-staging hook + config + graph (${existingGraphPath})…\n`
      : "\nRe-staging hook + config…\n",
  );
  const reinit = spawnSync("tokenomy", initArgs, { stdio: "inherit" });
  if (reinit.status !== 0) {
    process.stderr.write(
      "tokenomy update: install succeeded but `tokenomy init` failed. " +
        "Run it manually to finish.\n",
    );
    return reinit.status ?? 1;
  }

  process.stdout.write(
    `\n✓ Tokenomy updated to ${target}. Run \`tokenomy doctor\` to verify.\n`,
  );
  return 0;
};
