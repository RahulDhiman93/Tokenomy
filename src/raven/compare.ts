import { randomUUID } from "node:crypto";
import { assertPacketFresh } from "./brief.js";
import { renderComparisonMarkdown } from "./render.js";
import type {
  RavenComparison,
  RavenFinding,
  RavenPacket,
  RavenResult,
  RavenReview,
  RavenSeverity,
} from "./schema.js";
import { saveComparison, type RavenStore } from "./store.js";

const severityRank: Record<RavenSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const id = (): string =>
  `raven-compare-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

const bigrams = (s: string): Set<string> => {
  const n = s.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  for (let i = 0; i < Math.max(1, n.length - 1); i++) out.add(n.slice(i, i + 2));
  return out;
};

// Lightweight deterministic title similarity. The spec calls for a
// Jaro-Winkler-style threshold; this bigram Dice score gives stable matching
// without a dependency and behaves similarly for short finding titles.
export const titleSimilar = (a: string, b: string): boolean => {
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const aa = bigrams(a);
  const bb = bigrams(b);
  let hit = 0;
  for (const x of aa) if (bb.has(x)) hit++;
  const score = aa.size + bb.size > 0 ? (2 * hit) / (aa.size + bb.size) : 0;
  return score >= 0.85;
};

const findingMatches = (a: RavenFinding, b: RavenFinding): boolean => {
  if ((a.file ?? "") !== (b.file ?? "")) return false;
  if (a.line !== b.line) return false;
  if (a.severity !== b.severity) return false;
  return titleSimilar(a.title, b.title);
};

export const compareReviews = (
  packet: RavenPacket,
  cwd: string,
  store: RavenStore,
  reviews: RavenReview[],
): RavenResult<RavenComparison> => {
  const fresh = assertPacketFresh(packet, cwd);
  if (!fresh.ok) return fresh;
  if (reviews.length === 0) return { ok: false, reason: "no-reviews", hint: "Record at least one Raven review first." };

  const all = reviews.flatMap((r) => r.findings.map((f) => ({ review: r.review_id, finding: f })));
  const agreements: RavenFinding[] = [];
  const unique: RavenFinding[] = [];
  const used = new Set<number>();

  for (let i = 0; i < all.length; i++) {
    if (used.has(i)) continue;
    const cur = all[i]!;
    let matched = false;
    for (let j = i + 1; j < all.length; j++) {
      if (used.has(j)) continue;
      const other = all[j]!;
      if (cur.review === other.review) continue;
      if (findingMatches(cur.finding, other.finding)) {
        agreements.push(cur.finding);
        used.add(i);
        used.add(j);
        matched = true;
        break;
      }
    }
    if (!matched) unique.push(cur.finding);
  }

  const riskyUnique = unique.filter((f) => severityRank[f.severity] >= severityRank.high);
  const comparison: RavenComparison = {
    schema_version: 1,
    comparison_id: id(),
    packet_id: packet.packet_id,
    reviews: reviews.map((r) => r.review_id),
    agreements,
    disagreements: riskyUnique,
    unique_findings: unique,
    likely_false_positives: [],
    recommended_action:
      all.some((x) => x.finding.severity === "critical")
        ? "fix-first"
        : riskyUnique.length > 0
          ? "investigate"
          : "merge",
  };
  saveComparison(store, comparison, renderComparisonMarkdown(comparison));
  return { ok: true, data: comparison };
};

export const hasHighSeverityDisagreement = (comparison: RavenComparison): boolean =>
  comparison.disagreements.some((f) => severityRank[f.severity] >= severityRank.high);
