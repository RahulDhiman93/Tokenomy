import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ravenRepoDir } from "../core/paths.js";
import { atomicWrite } from "../util/atomic.js";
import { safeParse, stableStringify } from "../util/json.js";
import type {
  RavenComparison,
  RavenDecision,
  RavenPacket,
  RavenResult,
  RavenReview,
} from "./schema.js";

export interface RavenStore {
  dir: string;
  packetsDir: string;
  reviewsDir: string;
  comparisonsDir: string;
  decisionsDir: string;
}

export const ravenStoreForRepo = (repoId: string): RavenStore => {
  const dir = ravenRepoDir(repoId);
  return {
    dir,
    packetsDir: join(dir, "packets"),
    reviewsDir: join(dir, "reviews"),
    comparisonsDir: join(dir, "comparisons"),
    decisionsDir: join(dir, "decisions"),
  };
};

export const ensureRavenStore = (store: RavenStore): void => {
  mkdirSync(store.packetsDir, { recursive: true });
  mkdirSync(store.reviewsDir, { recursive: true });
  mkdirSync(store.comparisonsDir, { recursive: true });
  mkdirSync(store.decisionsDir, { recursive: true });
};

const writeJson = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, stableStringify(value) + "\n", false);
};

const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null;
  return safeParse<T>(readFileSync(path, "utf8")) ?? null;
};

export const savePacket = (store: RavenStore, packet: RavenPacket, markdown: string): void => {
  ensureRavenStore(store);
  writeJson(join(store.packetsDir, `${packet.packet_id}.json`), packet);
  atomicWrite(join(store.packetsDir, `${packet.packet_id}.md`), markdown, false);
  writeJson(join(store.dir, "latest.json"), packet);
  atomicWrite(join(store.dir, "latest.md"), markdown, false);
};

export const readLatestPacket = (store: RavenStore): RavenPacket | null =>
  readJson<RavenPacket>(join(store.dir, "latest.json"));

export const readPacket = (store: RavenStore, packetId?: string): RavenPacket | null =>
  packetId
    ? readJson<RavenPacket>(join(store.packetsDir, `${packetId}.json`))
    : readLatestPacket(store);

export const saveReview = (store: RavenStore, review: RavenReview, markdown: string): void => {
  ensureRavenStore(store);
  writeJson(join(store.reviewsDir, `${review.review_id}.json`), review);
  atomicWrite(join(store.reviewsDir, `${review.review_id}.md`), markdown, false);
};

export const readReview = (store: RavenStore, reviewId: string): RavenReview | null =>
  readJson<RavenReview>(join(store.reviewsDir, `${reviewId}.json`));

export const listReviews = (store: RavenStore, packetId?: string): RavenReview[] => {
  if (!existsSync(store.reviewsDir)) return [];
  return readdirSync(store.reviewsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson<RavenReview>(join(store.reviewsDir, name)))
    .filter((review): review is RavenReview => !!review && (!packetId || review.packet_id === packetId))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
};

export const saveComparison = (store: RavenStore, comparison: RavenComparison, markdown: string): void => {
  ensureRavenStore(store);
  writeJson(join(store.comparisonsDir, `${comparison.comparison_id}.json`), comparison);
  atomicWrite(join(store.comparisonsDir, `${comparison.comparison_id}.md`), markdown, false);
};

export const saveDecision = (store: RavenStore, decision: RavenDecision, markdown: string): void => {
  ensureRavenStore(store);
  writeJson(join(store.decisionsDir, `${decision.decision_id}.json`), decision);
  atomicWrite(join(store.decisionsDir, `${decision.decision_id}.md`), markdown, false);
};

export const cleanStore = (
  store: RavenStore,
  opts: { keep: number; olderThanDays: number; dryRun?: boolean },
): RavenResult<{ removed: string[] }> => {
  if (!existsSync(store.dir)) return { ok: true, data: { removed: [] } };
  const cutoff = Date.now() - opts.olderThanDays * 86_400_000;
  const removed: string[] = [];
  for (const sub of ["packets", "reviews", "comparisons", "decisions"]) {
    const dir = join(store.dir, sub);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir)
      .map((name) => {
        const path = join(dir, name);
        const st = statSync(path);
        return { path, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const beyondKeep = i >= opts.keep;
      const older = file.mtimeMs < cutoff;
      if (!beyondKeep && !older) continue;
      removed.push(file.path);
      if (!opts.dryRun) rmSync(file.path, { force: true });
    }
  }
  return { ok: true, data: { removed } };
};
