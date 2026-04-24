import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { loadConfig } from "../core/config.js";
import { graphMetaPath, graphSnapshotPath, tokenomyGraphRootDir, updateCachePath } from "../core/paths.js";
import type { SavingsLogEntry } from "../core/types.js";
import { TOKENOMY_VERSION } from "../core/version.js";
import { compareVersions } from "./update.js";
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
  // Populated when a cached `tokenomy update --check` reply indicates a
  // newer version is available on npm. Renders as `↑` after the version.
  updateAvailable?: string;
}

// Staleness window for the update cache. Past this, treat the cache as
// unknown rather than a stale hit (registry state drifts; a 2-week-old
// "update available" isn't signal worth rendering).
const UPDATE_CACHE_TTL_MS = 14 * 86_400_000;

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
  if (state.golem) {
    const savings = state.tokensToday > 0 ? ` · ${compact(state.tokensToday)} saved` : "";
    return `[Tokenomy ${versionTag} · GOLEM-${state.golem.toUpperCase()}${savings}${raven}]`;
  }
  if (state.tokensToday <= 0) return `[Tokenomy ${versionTag} · active${raven}]`;
  const graph =
    state.graph === "fresh"
      ? " · graph fresh"
      : state.graph === "stale"
        ? " · graph stale - rebuild"
        : "";
  return `[Tokenomy ${versionTag} · ${compact(state.tokensToday)} saved${graph}${raven}]`;
};

export const runStatusLine = (argv: string[]): number => {
  try {
    const cfg = loadConfig(process.cwd());
    const state: StatusLineState = {
      active: true,
      tokensToday: sumTodaySavings(cfg.log_path),
      graph: graphState(process.cwd()),
      golem: cfg.golem.enabled ? resolveGolemMode(cfg) : undefined,
      raven: cfg.raven.enabled,
      updateAvailable: readUpdateCache(),
    };
    if (argv.includes("--json")) process.stdout.write(JSON.stringify(state, null, 2) + "\n");
    else process.stdout.write(renderStatusLine(state) + "\n");
    return 0;
  } catch {
    process.stdout.write("");
    return 0;
  }
};
