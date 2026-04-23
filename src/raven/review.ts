import { randomUUID } from "node:crypto";
import { assertPacketFresh } from "./brief.js";
import { renderDecisionMarkdown, renderReviewMarkdown } from "./render.js";
import type {
  RavenAgent,
  RavenDecision,
  RavenDecisionValue,
  RavenFinding,
  RavenPacket,
  RavenResult,
  RavenReview,
  RavenVerdict,
} from "./schema.js";
import { readReview, saveDecision, saveReview, type RavenStore } from "./store.js";

const id = (prefix: string): string =>
  `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

export interface RecordReviewInput {
  packet: RavenPacket;
  cwd: string;
  store: RavenStore;
  agent: RavenAgent;
  verdict: RavenVerdict;
  findings?: RavenFinding[];
  questions?: string[];
  suggested_tests?: string[];
}

export const recordReview = (input: RecordReviewInput): RavenResult<RavenReview> => {
  const fresh = assertPacketFresh(input.packet, input.cwd);
  if (!fresh.ok) return fresh;
  const review: RavenReview = {
    schema_version: 1,
    review_id: id("raven-review"),
    packet_id: input.packet.packet_id,
    agent: input.agent,
    created_at: new Date().toISOString(),
    verdict: input.verdict,
    findings: input.findings ?? [],
    questions: input.questions ?? [],
    suggested_tests: input.suggested_tests ?? [],
  };
  saveReview(input.store, review, renderReviewMarkdown(review));
  return { ok: true, data: review };
};

export interface RecordDecisionInput {
  packet: RavenPacket;
  cwd: string;
  store: RavenStore;
  decision: RavenDecisionValue;
  rationale: string;
  decided_by: RavenAgent;
  review_ids: string[];
}

export const recordDecision = (input: RecordDecisionInput): RavenResult<RavenDecision> => {
  const fresh = assertPacketFresh(input.packet, input.cwd);
  if (!fresh.ok) return fresh;
  for (const reviewId of input.review_ids) {
    if (!readReview(input.store, reviewId)) {
      return { ok: false, reason: "review-not-found", hint: `Review not found: ${reviewId}` };
    }
  }
  const decision: RavenDecision = {
    schema_version: 1,
    decision_id: id("raven-decision"),
    packet_id: input.packet.packet_id,
    decision: input.decision,
    rationale: input.rationale,
    decided_by: input.decided_by,
    review_ids: input.review_ids,
    created_at: new Date().toISOString(),
  };
  saveDecision(input.store, decision, renderDecisionMarkdown(decision));
  return { ok: true, data: decision };
};
