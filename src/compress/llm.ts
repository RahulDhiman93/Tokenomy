import { spawnSync } from "node:child_process";

export interface LlmCompressResult {
  ok: boolean;
  text: string;
  reason?: string;
}

const PROMPT = `Rewrite this agent instruction file to use fewer tokens.

Hard requirements:
- Preserve all fenced code blocks byte-for-byte.
- Preserve all URLs byte-for-byte.
- Preserve all command examples byte-for-byte.
- Preserve YAML frontmatter byte-for-byte.
- Preserve file paths, flags, env vars, model names, versions, and numbers.
- Remove duplicate prose, filler, redundant headings, and verbose phrasing.
- Return only the rewritten file.

File:
`;

export const compressWithLocalClaude = (text: string): LlmCompressResult => {
  const probeCmd = process.platform === "win32" ? "where" : "which";
  const probe = spawnSync(probeCmd, ["claude"], { encoding: "utf8", timeout: 1_000 });
  if (probe.status !== 0) return { ok: false, text, reason: "claude-cli-not-found" };

  const result = spawnSync("claude", ["--print"], {
    input: PROMPT + text,
    encoding: "utf8",
    maxBuffer: Math.max(4 * 1024 * 1024, text.length * 4),
  });
  if (result.status !== 0 || result.stdout.length === 0) {
    return {
      ok: false,
      text,
      reason: result.stderr.trim() || `claude-exit-${result.status ?? "null"}`,
    };
  }
  return { ok: true, text: result.stdout };
};

