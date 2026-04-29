import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { graphMetaPath, graphSnapshotPath, tokenomyGraphRootDir, updateCachePath } from "../core/paths.js";
import type { SavingsLogEntry } from "../core/types.js";
import { TOKENOMY_VERSION } from "../core/version.js";
import { compareVersions } from "./update.js";
import { spawnUpdateCheck } from "./update-check-spawn.js";
import { resolveRepoId } from "../graph/repo-id.js";
import { resolveGolemMode } from "../rules/golem.js";
import { safeParse } from "../util/json.js";

const MAX_TAIL_BYTES = 256 * 1024;

export interface StatusLineState {
  active: boolean;
  tokensToday: number;
  graph?: "fresh" | "stale";
  golem?: string;
  raven?: boolean;
  // 0.1.4+: rendered as ` · Kratos` when continuous prompt-time scan is
  // active. Mirrors the Raven badge so users notice the security shield
  // is on at a glance.
  kratos?: boolean;
  // Populated when a cached `tokenomy update --check` reply indicates a
  // newer version is available on npm. Renders as `↑` after the version.
  updateAvailable?: string;
}

// Staleness window for the update cache. Past this, treat the cache as
// unknown rather than a stale hit (registry state drifts; a stale
// "update available" isn't signal worth rendering). 0.1.3+: dropped from
// 14 days to 24 hours since SessionStart and the statusline now keep the
// cache fresh proactively — past 24h means our refresh path is broken
// and we'd rather show "no update" than a stale hit.
const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// 0.1.3+: refresh-trigger window. When the cache is older than this, the
// statusline spawns a non-blocking `tokenomy update --check` so we pick
// up new releases promptly without waiting for the next SessionStart.
const UPDATE_CACHE_REFRESH_AFTER_MS = 3 * 60 * 60 * 1000; // 3h

export const readUpdateCache = (
  path = updateCachePath(),
  now = Date.now(),
): string | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = safeParse<{ remote?: string; fetched_at?: string }>(
      readFileSync(path, "utf8"),
    );
    if (!parsed?.remote || !parsed.fetched_at) return undefined;
    const fetchedAt = Date.parse(parsed.fetched_at);
    if (!Number.isFinite(fetchedAt)) return undefined;
    if (now - fetchedAt > UPDATE_CACHE_TTL_MS) return undefined;
    return compareVersions(parsed.remote, TOKENOMY_VERSION) > 0 ? parsed.remote : undefined;
  } catch {
    return undefined;
  }
};

// 0.1.3+: returns the cache age in ms, or null when the file is missing
// or unparseable. Drives the periodic refresh trigger in the statusline
// hot path. Cheap: one stat + one small read; bounded by node's cache.
export const updateCacheAgeMs = (path = updateCachePath(), now = Date.now()): number | null => {
  if (!existsSync(path)) return null;
  try {
    const parsed = safeParse<{ fetched_at?: string }>(readFileSync(path, "utf8"));
    if (!parsed?.fetched_at) return null;
    const fetchedAt = Date.parse(parsed.fetched_at);
    if (!Number.isFinite(fetchedAt)) return null;
    return Math.max(0, now - fetchedAt);
  } catch {
    return null;
  }
};

// 0.1.3+: returns true when the statusline should kick off a non-blocking
// `tokenomy update --check`. Triggers when:
//   - cache is missing entirely, OR
//   - cache is older than UPDATE_CACHE_REFRESH_AFTER_MS (3h).
// Caller is expected to spawn the refresh detached + unref'd; this helper
// is pure so tests can drive it deterministically.
export const shouldRefreshUpdateCache = (
  path = updateCachePath(),
  now = Date.now(),
): boolean => {
  const age = updateCacheAgeMs(path, now);
  if (age === null) return true;
  return age > UPDATE_CACHE_REFRESH_AFTER_MS;
};

const localDateKey = (d: Date): string => {
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
};

const readTail = (path: string): string => {
  if (!existsSync(path)) return "";
  const st = statSync(path);
  const size = Math.min(st.size, MAX_TAIL_BYTES);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, Math.max(0, st.size - size));
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

export const sumTodaySavings = (logPath: string, now = new Date()): number => {
  const today = localDateKey(now);
  let total = 0;
  for (const line of readTail(logPath).split("\n")) {
    if (!line.trim()) continue;
    const entry = safeParse<SavingsLogEntry>(line);
    if (!entry?.ts || localDateKey(new Date(entry.ts)) !== today) continue;
    if (typeof entry.tokens_saved_est === "number") total += entry.tokens_saved_est;
  }
  return total;
};

const compact = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${Math.round(tokens)}`;
};

const graphState = (cwd: string): "fresh" | "stale" | undefined => {
  if (!existsSync(tokenomyGraphRootDir())) return undefined;
  try {
    const { repoId } = resolveRepoId(cwd);
    if (!existsSync(graphMetaPath(repoId)) || !existsSync(graphSnapshotPath(repoId))) {
      return undefined;
    }
    const meta = safeParse<{ built_at?: string }>(readFileSync(graphMetaPath(repoId), "utf8"));
    if (!meta?.built_at) return "stale";
    const age = Date.now() - new Date(meta.built_at).getTime();
    return Number.isFinite(age) && age < 24 * 60 * 60 * 1000 ? "fresh" : "stale";
  } catch {
    return undefined;
  }
};

export const renderStatusLine = (state: StatusLineState): string => {
  if (!state.active) return "";
  const versionTag = `v${TOKENOMY_VERSION}${state.updateAvailable ? "↑" : ""}`;
  const raven = state.raven ? " · Raven" : "";
  const kratos = state.kratos ? " · Kratos" : "";
  if (state.golem) {
    const savings = state.tokensToday > 0 ? ` · ${compact(state.tokensToday)} saved` : "";
    return `[Tokenomy ${versionTag} · GOLEM-${state.golem.toUpperCase()}${savings}${raven}${kratos}]`;
  }
  if (state.tokensToday <= 0) return `[Tokenomy ${versionTag} · active${raven}${kratos}]`;
  const graph =
    state.graph === "fresh"
      ? " · graph fresh"
      : state.graph === "stale"
        ? " · graph stale - rebuild"
        : "";
  return `[Tokenomy ${versionTag} · ${compact(state.tokensToday)} saved${graph}${raven}${kratos}]`;
};

// 0.1.5+: hard wall budget for the statusline tick. Past this, bail to
// an empty string instead of risking a slow render that delays the user's
// CLI prompt. 50 ms matches the doctor advisory budget so users who pass
// it in `tokenomy doctor` are guaranteed to pass it at runtime.
const STATUSLINE_BUDGET_MS = 50;

export const runStatusLine = (argv: string[]): number => {
  const start = Date.now();
  const overBudget = (): boolean => Date.now() - start > STATUSLINE_BUDGET_MS;
  try {
    const cfg = loadConfig(process.cwd());
    if (overBudget()) {
      process.stdout.write("");
      return 0;
    }
    const state: StatusLineState = {
      active: true,
      tokensToday: sumTodaySavings(cfg.log_path),
      graph: graphState(process.cwd()),
      golem: cfg.golem.enabled ? resolveGolemMode(cfg) : undefined,
      raven: cfg.raven.enabled,
      // 0.1.4+: surface kratos when the continuous prompt-time shield
      // is on. Both flags must be true; `enabled: true, continuous: false`
      // is the CLI-only audit mode and shouldn't render a session badge.
      kratos: cfg.kratos?.enabled === true && cfg.kratos?.continuous === true,
      updateAvailable: readUpdateCache(),
    };
    if (overBudget()) {
      process.stdout.write("");
      return 0;
    }
    // 0.1.3+: keep the update cache fresh on the order of 3h so a new
    // release shows up in the statusline within one statusline tick of
    // crossing that threshold. The spawn is fully detached + unref'd so
    // it can't block the statusline's < 50ms budget.
    if (shouldRefreshUpdateCache()) spawnUpdateCheck();
    if (argv.includes("--json")) process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    else process.stdout.write(renderStatusLine(state) + "\n");
    return 0;
  } catch {
    process.stdout.write("");
    return 0;
  }
};
