import { performance } from "node:perf_hooks";
import { compressDeterministic } from "../compress/deterministic.js";
import { DEFAULT_CONFIG } from "../core/config.js";
import { estimateTokens } from "../core/gate.js";
import { mcpContentRule } from "../rules/mcp-content.js";
import { bashBoundRule } from "../rules/bash-bound.js";
import { readBoundRule } from "../rules/read-bound.js";
import { trimShellTraceText } from "../rules/shell-trace.js";

export interface BenchResult {
  scenario: string;
  bytes_in: number;
  bytes_out: number;
  tokens_in: number;
  tokens_out: number;
  tokens_saved: number;
  wall_ms: number;
  notes: string;
}

export interface BenchRun {
  generated_at: string;
  results: BenchResult[];
  total_tokens_saved: number;
  usd_saved: number;
}

const pricePerMillion = 3;

const measure = (scenario: string, run: () => Omit<BenchResult, "scenario" | "wall_ms">): BenchResult => {
  const start = performance.now();
  const result = run();
  return { scenario, wall_ms: Math.round((performance.now() - start) * 100) / 100, ...result };
};

const resultFromBytes = (bytesIn: number, bytesOut: number, notes: string): Omit<BenchResult, "scenario" | "wall_ms"> => {
  const tokensIn = estimateTokens(bytesIn);
  const tokensOut = estimateTokens(bytesOut);
  return {
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_saved: Math.max(0, tokensIn - tokensOut),
    notes,
  };
};

const scenarios: Record<string, () => BenchResult> = {
  "read-clamp-large-file": () =>
    measure("read-clamp-large-file", () => {
      const fakeSize = 10_000_000;
      const r = readBoundRule(
        { file_path: "/tmp/package-lock.json" },
        { ...DEFAULT_CONFIG, read: { ...DEFAULT_CONFIG.read, clamp_above_bytes: 1 } },
      );
      const bytesOut = r.kind === "clamp" ? DEFAULT_CONFIG.read.injected_limit * 50 : fakeSize;
      return resultFromBytes(fakeSize, bytesOut, "synthetic 10MB file with read clamp estimate");
    }),
  "bash-verbose-git-log": () =>
    measure("bash-verbose-git-log", () => {
      const r = bashBoundRule({ command: "git log --all --stat" }, DEFAULT_CONFIG);
      const bytesIn = 250_000;
      const bytesOut = r.kind === "bound" ? DEFAULT_CONFIG.bash.head_limit * 50 : bytesIn;
      return resultFromBytes(bytesIn, bytesOut, "synthetic verbose git log bounded by line cap");
    }),
  "mcp-atlassian-search": () =>
    measure("mcp-atlassian-search", () => {
      const issues = Array.from({ length: 80 }, (_, i) => ({
        key: `LX-${i}`,
        fields: {
          summary: `Very long issue summary ${i} `.repeat(20),
          description: `Long Jira body ${i} `.repeat(200),
          status: { name: "Open" },
          assignee: { displayName: "Dev" },
        },
      }));
      const response = { content: [{ type: "text", text: JSON.stringify({ issues }) }] };
      const r = mcpContentRule("mcp__Atlassian__searchJiraIssuesUsingJql", {}, response, DEFAULT_CONFIG);
      return r.kind === "trim"
        ? resultFromBytes(r.bytesIn, r.bytesOut, "captured-shape Atlassian search profile trim")
        : resultFromBytes(JSON.stringify(response).length, JSON.stringify(response).length, "no trim");
    }),
  "shell-trace-trim": () =>
    measure("shell-trace-trim", () => {
      const text = [
        "AssertionError: expected 1 to equal 2",
        ...Array.from({ length: 30 }, (_, i) => `    at fn${i} (/repo/src/${i}.ts:1:1)`),
        "1 failed, 47 passed",
      ].join("\n");
      const out = trimShellTraceText(text, { keepHead: 3, keepTail: 2, minFrames: 6 }).text;
      return resultFromBytes(Buffer.byteLength(text), Buffer.byteLength(out), "synthetic deep Jest stack trace");
    }),
  "compress-agent-memory": () =>
    measure("compress-agent-memory", () => {
      const text = Array.from({ length: 80 }, () => "- Prefer existing helpers.   \n- Prefer existing helpers.\n\n\n").join("");
      const out = compressDeterministic(text).text;
      return resultFromBytes(Buffer.byteLength(text), Buffer.byteLength(out), "deterministic CLAUDE.md-style duplicate cleanup");
    }),
  "golem-output-mode": () =>
    measure("golem-output-mode", () => {
      const verbose = "I will now explain what I changed and then provide a summary. ".repeat(120);
      const dense = "Changed files updated. Tests pass.\n";
      return resultFromBytes(Buffer.byteLength(verbose), Buffer.byteLength(dense), "fixed corpus assistant reply compression estimate");
    }),
};

export const scenarioNames = (): string[] => Object.keys(scenarios);

export const runBench = (scenario?: string): BenchRun => {
  const names = scenario ? [scenario] : scenarioNames();
  const results = names.map((name) => {
    const fn = scenarios[name];
    if (!fn) throw new Error(`Unknown bench scenario: ${name}`);
    return fn();
  });
  const total = results.reduce((sum, r) => sum + r.tokens_saved, 0);
  return {
    generated_at: new Date().toISOString(),
    results,
    total_tokens_saved: total,
    usd_saved: (total / 1_000_000) * pricePerMillion,
  };
};

export const renderBenchMarkdown = (run: BenchRun): string => {
  const lines = [
    "| Scenario | Tokens In | Tokens Out | Saved | Wall ms | Notes |",
    "|---|---:|---:|---:|---:|---|",
  ];
  for (const r of run.results) {
    lines.push(
      `| ${r.scenario} | ${r.tokens_in} | ${r.tokens_out} | ${r.tokens_saved} | ${r.wall_ms} | ${r.notes} |`,
    );
  }
  lines.push(`| **Total** |  |  | **${run.total_tokens_saved}** |  | ~$${run.usd_saved.toFixed(4)} saved @ $${pricePerMillion}/M |`);
  return lines.join("\n") + "\n";
};

