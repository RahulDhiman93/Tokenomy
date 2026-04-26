import { existsSync } from "node:fs";
import type { Config } from "../core/types.js";
import { graphMetaPath, tokenomyGraphRootDir } from "../core/paths.js";
import { resolveRepoId } from "../graph/repo-id.js";

// UserPromptSubmit prompt-classifier nudge.
//
// Fires once per user turn, before Claude plans. Inspects the user's prompt
// for action verbs ("build X", "refactor Y", "remove Z", "review the PR")
// and injects `additionalContext` recommending the right `tokenomy-graph`
// MCP tool for that intent.
//
// This closes the gap where the Write-only nudge misses planning-phase
// turns: users asking "plan X, no code" never trigger a Write, so the
// existing find_oss_alternatives nudge stays silent. The prompt classifier
// catches them upstream.
//
// Design:
// - Pure classifier. Regex-only, no LLM call, no registry call.
// - Four intents, toggleable independently via config.
// - Short-circuits on very short prompts ("yes", "go ahead") to avoid noise.
// - Skips when the prompt already mentions a tokenomy-graph tool — the user
//   is clearly already aware.
// - Only suggests graph-dependent tools (find_usages / get_impact_radius /
//   get_review_context) when a graph snapshot exists for this repo. The
//   find_oss_alternatives tool works without a graph, so it always nudges.
// - Never blocks. Never modifies the prompt. Output is pure append.

export type PromptIntent = "build" | "change" | "remove" | "review";

export interface PromptClassifierResult {
  kind: "nudge" | "passthrough";
  intent?: PromptIntent;
  additionalContext?: string;
}

interface IntentPattern {
  intent: PromptIntent;
  // Matches when any of these words appears as a standalone token in the
  // prompt. Boundaries matter — `readme` shouldn't match `read`.
  pattern: RegExp;
  // Whether this intent's suggestion requires the repo to already have a
  // graph snapshot. find_oss_alternatives works standalone; the others all
  // need the code graph.
  needsGraph: boolean;
  hint: (promptPreview: string) => string;
}

const previewPrompt = (prompt: string): string => {
  const cleaned = prompt.replace(/\s+/g, " ").trim();
  return cleaned.length > 80 ? cleaned.slice(0, 80) + "…" : cleaned;
};

const INTENTS: IntentPattern[] = [
  {
    intent: "build",
    // OSS-alt nudge fires ONLY when the prompt frames a library/package
    // search — "any existing library for X", "alternative to Y", "off-the-
    // shelf cron parser". The earlier broad-verb pattern (build|implement|
    // add|create|make|write) lit up on virtually every coding request,
    // which sent repeatedly-irrelevant package suggestions for project-
    // specific glue. Library-search framing requires the user to actually
    // be in research-mode for an external dependency.
    pattern:
      /\b(?:(?:any|some|an?)\s+(?:existing|known|good|popular|maintained)?\s*(?:library|libraries|package|packages|module|modules|sdk|wrapper|shim|polyfill|crate|gem)\s+(?:for|to|that)\b|is\s+there\s+(?:a|an|any)\s+(?:library|package|module|sdk|tool)\b|alternative(?:s)?\s+to\b|instead\s+of\s+(?:writing|building|implementing|rolling|reinventing)\b|off[-\s]the[-\s]shelf\b|out[-\s]of[-\s]the[-\s]box\b|already\s+exists?\b|reinvent(?:ing)?\s+the\s+wheel\b|similar\s+(?:library|package|module|tool|project)\b|find\s+(?:a|an|any)\s+(?:library|package|module|alternative)\b|use\s+(?:a|an|any)\s+(?:library|package|existing)\b|recommend(?:ation)?\s+(?:a|an|any)?\s*(?:library|package)\b)/i,
    needsGraph: false,
    hint: (preview) =>
      `[tokenomy-nudge (build): "${preview}" — before planning or writing code, ` +
      `call \`mcp__tokenomy-graph__find_oss_alternatives\` with a one-line description. ` +
      `It checks this repo, local branches, and maintained package registries (~1–2s). ` +
      `Report any repo matches and the top package pick in the plan before proposing ` +
      `a bespoke implementation. Skip only if you've already evaluated alternatives ` +
      `or this is clearly project-specific glue. Disable: ` +
      `\`tokenomy config set nudge.prompt_classifier.intents.build false\`.]`,
  },
  {
    intent: "change",
    pattern:
      /\b(refactor|rename|move|migrate|consolidate|restructure|extract|split|inline|replace|swap|rewrite)\b/i,
    needsGraph: true,
    hint: (preview) =>
      `[tokenomy-nudge (change): "${preview}" — before proposing any rename/refactor/move, ` +
      `call \`mcp__tokenomy-graph__find_usages\` on the target symbol, then ` +
      `\`mcp__tokenomy-graph__get_impact_radius\` on the file. Report the reverse-dep ` +
      `count + suggested_tests list in the plan. Anything > 10 callers is a high-` +
      `blast-radius change and should propose a staged migration. Disable: ` +
      `\`tokenomy config set nudge.prompt_classifier.intents.change false\`.]`,
  },
  {
    intent: "remove",
    pattern: /\b(remove|delete|drop|deprecate|prune|rip\s+out|tear\s+out|kill)\b/i,
    needsGraph: true,
    hint: (preview) =>
      `[tokenomy-nudge (remove): "${preview}" — before proposing the removal, call ` +
      `\`mcp__tokenomy-graph__get_impact_radius\` on the target file or symbol. Report ` +
      `the reverse-dep count. An "unused" claim is wrong if there's even one caller. ` +
      `If the graph shows callers, propose a deprecation path before deletion. Disable: ` +
      `\`tokenomy config set nudge.prompt_classifier.intents.remove false\`.]`,
  },
  {
    intent: "review",
    pattern:
      /\b(review|audit|analyze|summari[sz]e|blast[\s-]radius|regression[\s-]check|what\s+(?:changed|broke))\b/i,
    needsGraph: true,
    hint: (preview) =>
      `[tokenomy-nudge (review): "${preview}" — for change-set review, call ` +
      `\`mcp__tokenomy-graph__get_review_context\` with the list of changed files. ` +
      `It ranks hotspots + fanout so the review focuses on the blast-radius files ` +
      `instead of bikeshedding low-impact ones. Disable: ` +
      `\`tokenomy config set nudge.prompt_classifier.intents.review false\`.]`,
  },
];

const graphSnapshotExists = (cwd: string): boolean => {
  try {
    if (!existsSync(tokenomyGraphRootDir())) return false;
    const { repoId } = resolveRepoId(cwd);
    return existsSync(graphMetaPath(repoId));
  } catch {
    return false;
  }
};

// Already-aware short-circuit: if the user's prompt is itself directing
// Claude to a graph tool, don't double-nudge. Same for the OSS tool.
const alreadyMentionsTokenomy = (prompt: string): boolean =>
  /mcp__tokenomy-graph__|tokenomy[-_]graph|find_oss_alternatives|find_usages|get_impact_radius|get_review_context|get_minimal_context/i.test(
    prompt,
  );

export const classifyPromptRule = (
  prompt: string,
  cfg: Config,
  cwd: string,
): PromptClassifierResult => {
  const nudge = cfg.nudge;
  if (!nudge || !nudge.enabled) return { kind: "passthrough" };
  if (!nudge.prompt_classifier.enabled) return { kind: "passthrough" };
  if (typeof prompt !== "string") return { kind: "passthrough" };
  if (prompt.length < nudge.prompt_classifier.min_prompt_chars) {
    return { kind: "passthrough" };
  }
  if (alreadyMentionsTokenomy(prompt)) return { kind: "passthrough" };

  const intents = nudge.prompt_classifier.intents;
  const hasGraph = graphSnapshotExists(cwd);

  for (const entry of INTENTS) {
    if (!intents[entry.intent]) continue;
    if (entry.needsGraph && !hasGraph) continue;
    if (!entry.pattern.test(prompt)) continue;
    return {
      kind: "nudge",
      intent: entry.intent,
      additionalContext: entry.hint(previewPrompt(prompt)),
    };
  }
  return { kind: "passthrough" };
};
