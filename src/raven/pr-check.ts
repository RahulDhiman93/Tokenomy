import { assertPacketFresh } from "./brief.js";
import { compareReviews, hasHighSeverityDisagreement } from "./compare.js";
import type { RavenPacket, RavenPrReadiness, RavenResult, RavenReview } from "./schema.js";
import type { RavenStore } from "./store.js";

export const getPrReadiness = (
  packet: RavenPacket,
  cwd: string,
  store: RavenStore,
  reviews: RavenReview[],
): RavenResult<RavenPrReadiness> => {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const fresh = assertPacketFresh(packet, cwd);
  if (!fresh.ok) blocking.push("Current HEAD differs from packet HEAD.");
  if (reviews.length === 0) blocking.push("No reviews recorded for packet.");
  for (const review of reviews) {
    for (const finding of review.findings) {
      if (finding.resolved) continue;
      if (finding.severity === "critical") {
        blocking.push(`Critical finding: ${finding.title}`);
      }
    }
  }

  const comparison = reviews.length > 0 && fresh.ok ? compareReviews(packet, cwd, store, reviews) : null;
  if (comparison?.ok && hasHighSeverityDisagreement(comparison.data)) {
    warnings.push("High-severity disagreement exists between reviews.");
  }
  const graph = packet.graph?.review_context as { stale?: boolean } | undefined;
  if (graph?.stale) warnings.push("Graph snapshot is stale.");
  if (packet.repo.dirty) warnings.push("Packet was created from a dirty working tree.");
  const impact = packet.graph?.impact_radius as { ok?: boolean; data?: { suggested_tests?: string[] } } | undefined;
  const suggested = impact?.ok ? impact.data?.suggested_tests ?? [] : [];

  return {
    ok: true,
    data: {
      schema_version: 1,
      packet_id: packet.packet_id,
      ready: blocking.length > 0 ? "no" : warnings.length > 0 ? "risky" : "yes",
      blocking,
      warnings,
      suggested_tests: suggested,
      review_count: reviews.length,
    },
  };
};
