import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TOKENOMY_VERSION } from "../core/version.js";

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
}

const runNpm = (args: string[], inherit = false): { status: number; stdout: string; stderr: string } => {
  const r = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
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
export const fetchRegistryVersion = (tag: string): string | null => {
  const r = runNpm(["view", `tokenomy@${tag}`, "version"]);
  if (r.status !== 0) return null;
  const v = r.stdout.trim();
  return v.length > 0 ? v : null;
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

// Semver-ish pre-release comparison: returns >0 when a > b, <0 when a < b,
// 0 when equal. Handles `0.1.0-alpha.12` vs `0.1.0-alpha.3` correctly
// (numeric suffix) without pulling in a semver dep. Non-matching shapes
// fall back to lexical compare — safe because the guard only needs to
// detect obvious downgrades, not impose strict ordering on edge cases.
export const compareVersions = (a: string, b: string): number => {
  const parse = (v: string): [number[], number[]] => {
    const [main, pre = ""] = v.split("-", 2);
    const mainNums = (main ?? "").split(".").map((x) => Number(x)).map((x) => (Number.isFinite(x) ? x : 0));
    const preNums = pre
      .split(".")
      .map((x) => {
        const n = Number(x);
        return Number.isFinite(n) ? n : NaN;
      });
    return [mainNums, preNums.filter((n) => Number.isFinite(n)) as number[]];
  };
  const [aMain, aPre] = parse(a);
  const [bMain, bPre] = parse(b);
  for (let i = 0; i < Math.max(aMain.length, bMain.length); i++) {
    const diff = (aMain[i] ?? 0) - (bMain[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // No pre-release > with pre-release (e.g. 0.1.0 > 0.1.0-alpha.1)
  if (aPre.length === 0 && bPre.length > 0) return 1;
  if (aPre.length > 0 && bPre.length === 0) return -1;
  for (let i = 0; i < Math.max(aPre.length, bPre.length); i++) {
    const diff = (aPre[i] ?? 0) - (bPre[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

export const runUpdate = async (opts: UpdateOptions): Promise<number> => {
  const installed = TOKENOMY_VERSION;
  const tag = opts.tag ?? defaultTag();
  const target = opts.version ?? tag;

  if (opts.check) {
    const latest = fetchRegistryVersion(tag);
    if (latest === null) {
      process.stderr.write(
        `tokenomy update: could not query npm registry for tokenomy@${tag}. ` +
          `Is npm on PATH and is the network reachable?\n`,
      );
      return 2;
    }
    process.stdout.write(`  installed:       ${installed}\n`);
    process.stdout.write(`  ${(tag + " on npm").padEnd(16)}: ${latest}\n`);
    const cmp = compareVersions(latest, installed);
    if (cmp === 0) {
      process.stdout.write(`  ✓ Up to date\n`);
      return 0;
    }
    if (cmp < 0) {
      process.stdout.write(
        `  ✓ Up to date (installed is newer than the \`${tag}\` dist-tag on npm).\n`,
      );
      return 0;
    }
    process.stdout.write(
      `  ⚠ Update available. Run \`tokenomy update${
        opts.tag && opts.tag !== defaultTag() ? ` --tag=${tag}` : ""
      }\`.\n`,
    );
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
          `  --version=${installed.split("-alpha.")[0] ?? installed} to pin a specific release.\n`,
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
  process.stdout.write("\nRe-staging hook + config…\n");
  const reinit = spawnSync("tokenomy", ["init"], { stdio: "inherit" });
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
