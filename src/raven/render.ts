import type {
  RavenComparison,
  RavenDecision,
  RavenFinding,
  RavenPacket,
  RavenPrReadiness,
  RavenReview,
} from "./schema.js";

const clip = (text: string, maxBytes: number): string => {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const keep = Math.max(0, maxBytes - 80);
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > keep) break;
    out += ch;
    used += b;
  }
  return `${out}\n... (+${bytes - used} bytes dropped)\n`;
};

const list = (items: string[]): string => (items.length ? items.map((x) => `- ${x}`).join("\n") : "- (none)");

export const renderPacketMarkdown = (packet: RavenPacket, maxBytes = 12_000): string => {
  const lines: string[] = [];
  lines.push(`# Tokenomy Raven Packet`);
  lines.push("");
  lines.push(`Packet: \`${packet.packet_id}\``);
  lines.push(`Created: ${packet.created_at}`);
  lines.push(`Repo: \`${packet.repo.root}\``);
  lines.push(`Branch: \`${packet.repo.branch}\``);
  lines.push(`HEAD: \`${packet.repo.head_sha}\``);
  lines.push(`Dirty: ${packet.repo.dirty ? "yes" : "no"}`);
  if (packet.goal) lines.push(`Goal: ${packet.goal}`);
  lines.push("");
  lines.push(`## Changed Files`);
  lines.push(list(packet.git.changed_files));
  lines.push("");
  lines.push(`## Review Focus`);
  lines.push(list(packet.review_focus));
  lines.push("");
  lines.push(`## Risks`);
  lines.push(list(packet.risks));
  lines.push("");
  lines.push(`## Suggested Tests`);
  const impact = packet.graph?.impact_radius as { data?: { suggested_tests?: string[] } } | undefined;
  lines.push(list(impact?.data?.suggested_tests ?? []));
  lines.push("");
  lines.push(`## Diff Summary`);
  if (packet.git.diff_summary.length === 0) {
    lines.push("(no diff captured)");
  } else {
    for (const entry of packet.git.diff_summary) {
      lines.push(`### ${entry.file}${entry.truncated ? " (truncated)" : ""}`);
      lines.push("```diff");
      lines.push(entry.patch);
      lines.push("```");
    }
  }
  if (packet.git.diff_truncated) {
    lines.push(`_Diff truncated; ${packet.git.dropped_files} file(s) omitted._`);
  }
  lines.push("");
  lines.push(`## Graph Context`);
  if (!packet.graph) {
    lines.push("(graph context unavailable)");
  } else {
    lines.push("```json");
    lines.push(JSON.stringify(packet.graph, null, 2));
    lines.push("```");
  }
  lines.push("");
  lines.push(`## Open Questions`);
  lines.push(list(packet.open_questions));
  return clip(lines.join("\n") + "\n", maxBytes);
};

const renderFinding = (f: RavenFinding): string =>
  `- [${f.severity}] ${f.file ?? "(unknown file)"}${f.line ? `:${f.line}` : ""} — ${f.title}`;

export const renderReviewMarkdown = (review: RavenReview): string => {
  const lines = [
    `# Raven Review`,
    "",
    `Review: \`${review.review_id}\``,
    `Packet: \`${review.packet_id}\``,
    `Agent: ${review.agent}`,
    `Verdict: ${review.verdict}`,
    "",
    "## Findings",
    ...(review.findings.length ? review.findings.map(renderFinding) : ["- (none)"]),
    "",
    "## Questions",
    list(review.questions),
    "",
    "## Suggested Tests",
    list(review.suggested_tests),
    "",
  ];
  return lines.join("\n");
};

export const renderComparisonMarkdown = (comparison: RavenComparison): string =>
  [
    "# Raven Comparison",
    "",
    `Comparison: \`${comparison.comparison_id}\``,
    `Packet: \`${comparison.packet_id}\``,
    `Recommended action: ${comparison.recommended_action}`,
    "",
    "## Agreements",
    ...(comparison.agreements.length ? comparison.agreements.map(renderFinding) : ["- (none)"]),
    "",
    "## Disagreements",
    ...(comparison.disagreements.length ? comparison.disagreements.map(renderFinding) : ["- (none)"]),
    "",
    "## Unique Findings",
    ...(comparison.unique_findings.length ? comparison.unique_findings.map(renderFinding) : ["- (none)"]),
    "",
  ].join("\n");

export const renderReadinessMarkdown = (readiness: RavenPrReadiness): string =>
  [
    "# Raven PR Readiness",
    "",
    `Packet: \`${readiness.packet_id}\``,
    `Ready: ${readiness.ready}`,
    `Reviews: ${readiness.review_count}`,
    "",
    "## Blocking",
    list(readiness.blocking),
    "",
    "## Warnings",
    list(readiness.warnings),
    "",
    "## Suggested Tests",
    list(readiness.suggested_tests),
    "",
  ].join("\n");

export const renderDecisionMarkdown = (decision: RavenDecision): string =>
  [
    "# Raven Decision",
    "",
    `Decision: \`${decision.decision_id}\``,
    `Packet: \`${decision.packet_id}\``,
    `Value: ${decision.decision}`,
    `By: ${decision.decided_by}`,
    "",
    decision.rationale,
    "",
  ].join("\n");
