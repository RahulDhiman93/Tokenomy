import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { platform } from "node:os";
import { feedbackLogPath } from "../core/paths.js";
import { TOKENOMY_VERSION } from "../core/version.js";
import { listAgentDetection } from "./agents/index.js";

// `tokenomy feedback "free text"` — backend-less feedback channel.
//
// Strategy (no service to operate, no auth to manage):
//   1. Always append the submission to ~/.tokenomy/feedback.jsonl so the
//      user has a local copy regardless of what happens next.
//   2. If `gh` CLI is on PATH, run `gh issue create` directly. Files an
//      issue under the user's own GitHub account, full body, full Markdown,
//      `feedback` label. Best path — your triage queue gets it immediately.
//   3. Otherwise, build a prefilled `https://github.com/.../issues/new` URL
//      and open it via the platform's default browser. User reviews +
//      clicks Submit. Works for everyone.
//   4. If even the browser open fails (headless / no display), print the
//      URL so the user can copy/paste.
//
// We never POST to a third-party service, never collect telemetry beyond
// what the user typed + a small env block they can review.

const REPO_SLUG = "RahulDhiman93/Tokenomy";

const titleFromBody = (body: string): string => {
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  const seed = firstLine.length > 0 ? firstLine : body.trim();
  const truncated = seed.length > 60 ? `${seed.slice(0, 60).trimEnd()}…` : seed;
  return `feedback: ${truncated}`;
};

interface EnvBlock {
  version: string;
  node: string;
  platform: string;
  agents: string[];
}

const buildEnvBlock = (): EnvBlock => ({
  version: TOKENOMY_VERSION,
  node: process.version,
  platform: `${platform()} ${process.arch}`,
  agents: listAgentDetection()
    .filter((a) => a.detected)
    .map((a) => a.agent),
});

const buildBody = (text: string, env: EnvBlock): string =>
  [
    "## Feedback",
    "",
    text.trim(),
    "",
    "## Environment",
    "",
    "```",
    `tokenomy:  ${env.version}`,
    `node:      ${env.node}`,
    `platform:  ${env.platform}`,
    `agents:    ${env.agents.length > 0 ? env.agents.join(", ") : "none detected"}`,
    "```",
    "",
    "_Submitted via `tokenomy feedback`._",
  ].join("\n");

const appendLocal = (entry: { ts: string; text: string; title: string; submitted_via: string }): void => {
  const path = feedbackLogPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n", { flag: "a" });
  } catch {
    // best-effort; never fail the command on log write
  }
};

const hasGh = (): boolean => {
  const r = spawnSync("gh", ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 });
  return r.status === 0;
};

const ghIsAuthed = (): boolean => {
  const r = spawnSync("gh", ["auth", "status"], { stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
  return r.status === 0;
};

const submitViaGh = (title: string, body: string): { ok: true; url: string } | { ok: false; reason: string } => {
  const r = spawnSync(
    "gh",
    [
      "issue",
      "create",
      "--repo",
      REPO_SLUG,
      "--title",
      title,
      "--body",
      body,
      "--label",
      "feedback",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  );
  if (r.status !== 0) {
    return { ok: false, reason: r.stderr.trim() || `gh exited with ${r.status ?? "null"}` };
  }
  // `gh issue create` prints the new issue URL on stdout.
  const url = r.stdout.trim().split("\n").pop() ?? "";
  return { ok: true, url };
};

const buildPrefilledUrl = (title: string, body: string): string => {
  // GitHub's issue-new endpoint accepts URL-encoded title/body/labels query
  // params. Practical URL length cap is ~8k chars; truncate body if needed.
  const MAX_BODY = 6_000;
  const safeBody = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n\n…(truncated by tokenomy feedback; see ~/.tokenomy/feedback.jsonl for the full text)` : body;
  const params = new URLSearchParams({
    title,
    body: safeBody,
    labels: "feedback",
  });
  return `https://github.com/${REPO_SLUG}/issues/new?${params.toString()}`;
};

const openInBrowser = (url: string): boolean => {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  const args = platform() === "win32" ? ["", url] : [url];
  const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 5_000 });
  return r.status === 0;
};

const printUsage = (): void => {
  process.stderr.write(
    "Usage:\n" +
      '  tokenomy feedback "your feedback text here"\n' +
      "\n" +
      "  Files a labeled issue at https://github.com/" + REPO_SLUG + "/issues.\n" +
      "  Uses `gh` CLI when available; falls back to opening a prefilled\n" +
      "  GitHub issue URL in your default browser.\n" +
      "\n" +
      "  A local copy of every submission is appended to ~/.tokenomy/feedback.jsonl.\n",
  );
};

export const runFeedback = (argv: string[]): number => {
  const text = argv
    .filter((a) => !a.startsWith("--"))
    .join(" ")
    .trim();
  if (text.length === 0) {
    printUsage();
    return 2;
  }

  const env = buildEnvBlock();
  const body = buildBody(text, env);
  const title = titleFromBody(text);
  const ts = new Date().toISOString();

  // Always log locally first — even if gh and the browser both fail, the
  // user still has the message saved.
  appendLocal({ ts, text, title, submitted_via: "pending" });

  if (!argv.includes("--print-only") && hasGh() && ghIsAuthed()) {
    const result = submitViaGh(title, body);
    if (result.ok) {
      appendLocal({ ts, text, title, submitted_via: `gh:${result.url}` });
      process.stdout.write(`✓ Feedback filed: ${result.url}\n`);
      process.stdout.write("  Local copy: ~/.tokenomy/feedback.jsonl\n");
      return 0;
    }
    process.stderr.write(`gh issue create failed: ${result.reason}\n`);
    process.stderr.write("Falling back to browser…\n\n");
  }

  const url = buildPrefilledUrl(title, body);
  if (argv.includes("--print-only") || !openInBrowser(url)) {
    process.stdout.write("Open this URL to file the issue (or copy + paste):\n\n");
    process.stdout.write(`  ${url}\n\n`);
  } else {
    process.stdout.write("✓ Opened a prefilled GitHub issue in your default browser.\n");
    process.stdout.write("  Click Submit to send. Local copy: ~/.tokenomy/feedback.jsonl\n");
  }
  appendLocal({ ts, text, title, submitted_via: "browser" });
  return 0;
};
