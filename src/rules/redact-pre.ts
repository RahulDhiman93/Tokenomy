import type { Config } from "../core/types.js";
import { BUILTIN_PATTERNS, redactSecrets } from "./redact.js";

export interface RedactPreResult {
  kind: "passthrough" | "redacted" | "warned";
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  // Pattern name → count, for logging/telemetry.
  counts?: Record<string, number>;
  total?: number;
}

const activePatterns = (cfg: Config) => {
  const disabled = new Set(cfg.redact.disabled_patterns ?? []);
  return BUILTIN_PATTERNS.filter((p) => !disabled.has(p.name));
};

// Bash: conservative. A secret in a header or URL query is clearly in-transit;
// redact AND warn. A secret that looks like a bare positional argument is
// ambiguous — the user may legitimately be passing a real key to a tool they
// wrote. In that case we DO NOT rewrite the command; we only emit a warning
// so the agent sees the risk in context. This matches the plan's
// `warn-don't-replace` contract for bare args.
//
// Header regex allows:
//   - `-H` or `--header`
//   - single- or double-quoted values (which may span escaped newlines /
//     shell line continuations), or unquoted value up to first whitespace
//   - common credential header names
// URL pattern allows query-string tokens (`?token=…`, `&api_key=…`).
// The `s` flag lets `.*?` span newlines so multi-line headers still match.
const LOOKS_LIKE_HEADER_OR_URL_RE =
  /(?:-H|--header)\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)|https?:\/\/[^\s'"`]+/gis;

const mergeCounts = (
  a: Record<string, number>,
  b: Record<string, number>,
): Record<string, number> => {
  const out: Record<string, number> = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

const redactInBash = (command: string, cfg: Config): RedactPreResult => {
  const patterns = activePatterns(cfg);
  const headerSegments = command.match(LOOKS_LIKE_HEADER_OR_URL_RE) ?? [];
  const headerText = headerSegments.join("\n");
  const headerHits = redactSecrets(headerText, patterns);

  let rewritten = command;
  if (headerHits.total > 0) {
    for (const seg of headerSegments) {
      const { redacted } = redactSecrets(seg, patterns);
      if (redacted !== seg) rewritten = rewritten.split(seg).join(redacted);
    }
  }

  // After any header/url rewrite, scan the REMAINING (possibly rewritten)
  // command for bare-arg credentials. Catches the mixed case where a
  // command contains both an in-transit header secret AND a separate
  // bare-arg credential — finding #3 from Codex review.
  const bareHits = redactSecrets(rewritten, patterns);
  const totalCounts = mergeCounts(headerHits.counts, bareHits.counts);
  const totalHits = headerHits.total + bareHits.total;

  if (headerHits.total > 0 && bareHits.total > 0) {
    return {
      kind: "redacted",
      updatedInput: { command: rewritten },
      additionalContext:
        `[tokenomy-redact-pre: redacted ${headerHits.total} header credential(s) from Bash; ` +
        `${bareHits.total} bare-arg credential(s) remain in-place — review before running. ` +
        `(${Object.keys(totalCounts).join(", ")})]`,
      counts: totalCounts,
      total: totalHits,
    };
  }

  if (headerHits.total > 0) {
    return {
      kind: "redacted",
      updatedInput: { command: rewritten },
      additionalContext:
        `[tokenomy-redact-pre: redacted ${headerHits.total} credential(s) from Bash command ` +
        `(${Object.keys(headerHits.counts).join(", ")}). Original values removed before send.]`,
      counts: headerHits.counts,
      total: headerHits.total,
    };
  }

  if (bareHits.total > 0) {
    return {
      kind: "warned",
      additionalContext:
        `[tokenomy-redact-pre: ${bareHits.total} credential-like token(s) detected in Bash command ` +
        `(${Object.keys(bareHits.counts).join(", ")}). Passthrough — review before running.]`,
      counts: bareHits.counts,
      total: bareHits.total,
    };
  }
  return { kind: "passthrough" };
};

// Write / Edit: content is meant to go into a file on disk. Always redact
// inline — these are NOT the user's interactive commands, they're agent-
// generated file content where a leaked secret would be persisted.
const redactInText = (
  text: string,
  cfg: Config,
): { redacted: string; counts: Record<string, number>; total: number } => {
  const patterns = activePatterns(cfg);
  return redactSecrets(text, patterns);
};

export const redactPreRule = (
  toolName: string,
  toolInput: Record<string, unknown>,
  cfg: Config,
): RedactPreResult => {
  try {
    if (cfg.redact.enabled !== true) return { kind: "passthrough" };
    if (cfg.redact.pre_tool_use !== true) return { kind: "passthrough" };

    if (toolName === "Bash") {
      const command = toolInput["command"];
      if (typeof command !== "string" || command.length < 8) return { kind: "passthrough" };
      return redactInBash(command, cfg);
    }

    if (toolName === "Write") {
      const content = toolInput["content"];
      if (typeof content !== "string" || content.length === 0) return { kind: "passthrough" };
      const r = redactInText(content, cfg);
      if (r.total === 0) return { kind: "passthrough" };
      return {
        kind: "redacted",
        updatedInput: { ...toolInput, content: r.redacted },
        additionalContext:
          `[tokenomy-redact-pre: redacted ${r.total} credential(s) from Write content ` +
          `(${Object.keys(r.counts).join(", ")}).]`,
        counts: r.counts,
        total: r.total,
      };
    }

    if (toolName === "Edit") {
      const ns = toolInput["new_string"];
      if (typeof ns !== "string" || ns.length === 0) return { kind: "passthrough" };
      const r = redactInText(ns, cfg);
      if (r.total === 0) return { kind: "passthrough" };
      return {
        kind: "redacted",
        updatedInput: { ...toolInput, new_string: r.redacted },
        additionalContext:
          `[tokenomy-redact-pre: redacted ${r.total} credential(s) from Edit new_string ` +
          `(${Object.keys(r.counts).join(", ")}).]`,
        counts: r.counts,
        total: r.total,
      };
    }
    return { kind: "passthrough" };
  } catch {
    return { kind: "passthrough" };
  }
};
