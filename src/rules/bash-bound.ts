import type { Config } from "../core/types.js";

// Phase 4 — Bash input-bounder.
//
// Output-focused shell commands (`git log`, `find`, `ls -R`, `ps aux`, …)
// routinely dump tens of thousands of lines when run unbounded. Tokenomy's
// PreToolUse hook for `Read` already clamps file reads; this rule does the
// equivalent for `Bash` by rewriting the command string to
//
//     set -o pipefail; <original command> | awk 'NR<=<N>'
//
// `awk 'NR<=N'` is used instead of `head -n N` so the producer doesn't
// receive SIGPIPE (which would surface as exit 141 under pipefail). Awk
// consumes all producer output, prints only the first N lines, and exits 0;
// `set -o pipefail` preserves the producer's own non-zero exit for the rare
// case where the bounded command failed.
//
// The rule is conservative — any ambiguity about shell semantics (compound
// commands, redirection, subshells, heredocs, user-owned pipelines) short-
// circuits to passthrough. Fail-open is the contract.

export interface BashBoundResult {
  kind: "passthrough" | "bound";
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  originalCommand?: string;
  boundedCommand?: string;
  patternName?: string;
  reason?: string;
}

const P = (reason: string): BashBoundResult => ({ kind: "passthrough", reason });

// Head-limit validation. Returns the coerced integer or null when the config
// value is non-numeric, non-integer, or outside the allowed band. The rule
// must never interpolate an unvalidated value into shell.
const validateHeadLimit = (raw: unknown): number | null => {
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  if (n < 20 || n > 10_000) return null;
  return n;
};

// ————————————————————————————————————————————————————————————————
// Already-bounded + unsafe-to-rewrite detection
// ————————————————————————————————————————————————————————————————

// Trailing pipe to a bounding tool or tee. The rule treats these as the
// user's explicit intent and always passes through.
const ALREADY_BOUNDED_PIPE_RE =
  /\|\s*(head|tail|wc|less|more|file|tee)(\s|$)/;

// grep -m N bounds the count of matches even though the command is piping.
const GREP_MAX_RE = /\|\s*grep\s+[^|]*\s-m\s*\d+/;

// Explicit count / depth / line flags on the primary command itself.
const BOUND_FLAG_RE =
  /(?:^|\s)(-n\d+|-n\s+\d+|--max-count(?:=|\s+)\d+|--tail(?:=|\s+)\d+|--depth(?:=|\s+)\d+|-maxdepth\s+\d+|--lines(?:=|\s+)\d+)(?:\s|$)/;

const hasAlreadyBoundFlag = (cmd: string): boolean =>
  ALREADY_BOUNDED_PIPE_RE.test(cmd) ||
  GREP_MAX_RE.test(cmd) ||
  BOUND_FLAG_RE.test(cmd);

// Top-level compound / subshell / heredoc constructs. The regex matches
// outside quotes only approximately — any uncertainty yields passthrough,
// which is the safe direction.
//
// Note: shell comments (`#`) used to live here too for safety; they are
// now handled by stripTrailingComment() which quote-aware-strips them
// before the rest of the pipeline runs, so `git log # note` becomes
// bindable as `git log` with the comment discarded.
const UNSAFE_CONSTRUCTS_RE =
  /(?:^|\s)(?:&&|\|\||;|&\s*$)|\$\(|`|<<|{\s|\(\s|>|>>|&>|>\||>&/;

// Walk the command left-to-right tracking quote state, and truncate at the
// first unquoted `#` that starts a word (or that starts the whole command).
// Handles `echo "foo # bar"` (unchanged — # is inside quotes) and escaped
// quotes (`\'` / `\"`). Backslash-escaped `\#` also preserved. Returns the
// pair so the caller can decide whether a comment was actually stripped.
export const stripTrailingComment = (
  cmd: string,
): { command: string; strippedComment: boolean } => {
  let inSingle = false;
  let inDouble = false;
  let prevWasWhitespace = true; // start-of-string counts as a word boundary
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]!;
    if (ch === "\\" && i + 1 < cmd.length) {
      // escape: skip the next char, treat as non-whitespace
      i++;
      prevWasWhitespace = false;
      continue;
    }
    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      prevWasWhitespace = false;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      prevWasWhitespace = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "#" && prevWasWhitespace) {
      return { command: cmd.slice(0, i).replace(/\s+$/, ""), strippedComment: true };
    }
    prevWasWhitespace = /\s/.test(ch);
  }
  return { command: cmd, strippedComment: false };
};

const hasNewline = (cmd: string): boolean => cmd.includes("\n") || cmd.includes("\r");

// Has a `|` that isn't part of ALREADY_BOUNDED_PIPE_RE / GREP_MAX_RE.
// `ps aux | awk ...` is the user's pipeline; we don't tack another pipe on.
const hasUserPipe = (cmd: string): boolean => {
  if (!cmd.includes("|")) return false;
  // Strip known-safe trailing forms; if any `|` remains, it's the user's.
  const stripped = cmd
    .replace(ALREADY_BOUNDED_PIPE_RE, "")
    .replace(GREP_MAX_RE, "");
  return stripped.includes("|");
};

// Streaming / interactive commands: never bind.
const STREAMING_RE =
  /(?:^|\s)(watch|top|htop|less|more)(\s|$)|(?:^|\s)(-f|-F|--follow)(\s|$)/;

// ————————————————————————————————————————————————————————————————
// Canonicalisation: strip `sudo`, `time`, env-var prefixes.
// ————————————————————————————————————————————————————————————————

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+/;

const canonicalise = (cmd: string): string => {
  let rest = cmd.trimStart();
  // Peel leading env assignments (FOO=bar BAZ=qux cmd ...).
  while (ENV_ASSIGN_RE.test(rest)) {
    rest = rest.replace(ENV_ASSIGN_RE, "").trimStart();
  }
  // Peel sudo / time prefixes (once each is enough; more is exotic).
  if (/^sudo\s+/.test(rest)) rest = rest.replace(/^sudo\s+/, "").trimStart();
  if (/^time\s+/.test(rest)) rest = rest.replace(/^time\s+/, "").trimStart();
  return rest;
};

// ————————————————————————————————————————————————————————————————
// Verbose-pattern matchers. Each returns a pattern name when the canonical
// command should be bound, or null otherwise. Built-ins are deliberately
// scoped to output-focused commands (never exit-status-sensitive ones).
// ————————————————————————————————————————————————————————————————

interface Pattern {
  name: string;
  test: (cmd: string) => boolean;
}

const FIND_UNSAFE_ACTION_RE =
  /(?:^|\s)(-exec|-execdir|-delete|-ok|-okdir|-print0|-fprint|-fprint0|-fprintf)(\s|$)/;

// Per-pattern "also already-bounded" checks. The general BOUND_FLAG_RE only
// catches generic flag forms (`-n N`, `--max-count N`, ...). Tool-specific
// native limits need tool-specific regexes.
const EXTRA_BOUND_CHECKS: Record<string, RegExp> = {
  // `git log -20` is shorthand for `-n20`; same for `git show -20`. Also
  // `git log -<digits>` after any flags. Restrict to a bare integer so we
  // don't false-positive on things like `-1` used as `-1` commit selector
  // (which is the bound we actually want to respect).
  "git-log": /(?:^|\s)-\d+(?:\s|$)/,
  "git-show": /(?:^|\s)-\d+(?:\s|$)/,
  // `tree -L N` / `tree -LN` bounds depth.
  tree: /(?:^|\s)-L\s*\d+(?:\s|$)/,
};

const BUILT_IN_PATTERNS: Pattern[] = [
  {
    name: "git-log",
    test: (c) => /^git\s+log(\s|$)/.test(c),
  },
  {
    name: "git-show",
    test: (c) => /^git\s+show(\s|$)/.test(c),
  },
  {
    name: "find",
    // Bare `find` with no side-effectful action flag. Implicit -print is
    // safe to bound; `-exec`, `-delete`, `-print0` are not.
    test: (c) => /^find(\s|$)/.test(c) && !FIND_UNSAFE_ACTION_RE.test(c),
  },
  {
    name: "ls-recursive",
    // Matches -R, -Rl, -lR, -aR, etc.
    test: (c) => /^ls(\s+-\w*R\w*)(\s|$)/.test(c),
  },
  {
    name: "ps",
    test: (c) => /^ps\s+(aux|auxww|auxf|-ef|-axo|-A)(\s|$)/.test(c),
  },
  {
    name: "docker-logs",
    test: (c) => /^docker\s+logs(\s|$)/.test(c),
  },
  {
    name: "journalctl",
    test: (c) => /^journalctl(\s|$)/.test(c),
  },
  {
    name: "kubectl-logs",
    test: (c) => /^kubectl\s+logs(\s|$)/.test(c),
  },
  {
    name: "tree",
    test: (c) => /^tree(\s|$)/.test(c),
  },
];

// Per-pattern suggestion shown in additionalContext so the agent knows
// the native flag to reach for if more output is genuinely needed.
const NATIVE_HINT: Record<string, string> = {
  "git-log": "--max-count=N",
  "git-show": "-- <path>",
  find: "-maxdepth N or -path <scope>",
  "ls-recursive": "narrower target directory",
  ps: "pipe to grep / awk for a filter",
  "docker-logs": "--tail N",
  journalctl: "-n N / --since",
  "kubectl-logs": "--tail=N",
  tree: "-L N",
};

// ————————————————————————————————————————————————————————————————
// Main entry.
// ————————————————————————————————————————————————————————————————

export const bashBoundRule = (
  toolInput: Record<string, unknown>,
  cfg: Config,
): BashBoundResult => {
  try {
    if (!cfg.bash.enabled) return P("disabled");

    if (toolInput["run_in_background"] === true) {
      return P("run-in-background");
    }

    const rawCommand = toolInput["command"];
    if (typeof rawCommand !== "string") return P("no-command");
    if (rawCommand.length < cfg.bash.min_command_length) return P("too-short");

    const head_limit = validateHeadLimit(cfg.bash.head_limit);
    if (head_limit === null) return P("invalid-head-limit");

    // Strip a trailing unquoted shell comment (quote-aware) BEFORE the rest
    // of the pipeline runs. `git log # note` becomes `git log` here so we
    // can actually bind it; `echo "foo # bar"` stays intact. The stripped
    // form is what we rewrite + hand back to Claude Code.
    const { command: stripped } = stripTrailingComment(rawCommand);
    const command = stripped.length >= cfg.bash.min_command_length ? stripped : rawCommand;
    if (command.length < cfg.bash.min_command_length) return P("too-short-after-strip");

    if (hasNewline(command)) return P("multiline");
    if (hasAlreadyBoundFlag(command)) return P("explicit-bound");
    if (UNSAFE_CONSTRUCTS_RE.test(command)) return P("unsafe-construct");
    if (hasUserPipe(command)) return P("user-pipeline");
    if (STREAMING_RE.test(command)) return P("streaming");

    const canonical = canonicalise(command);

    // Built-in patterns first, then custom_verbose. Custom entries are
    // matched as a literal prefix up to whitespace so users can't sneak
    // regex metacharacters into shell.
    let matched: string | null = null;
    for (const p of BUILT_IN_PATTERNS) {
      if (p.test(canonical)) {
        matched = p.name;
        break;
      }
    }
    if (!matched) {
      for (const v of cfg.bash.custom_verbose) {
        if (!v) continue;
        if (canonical === v || canonical.startsWith(`${v} `)) {
          matched = v;
          break;
        }
      }
    }
    if (!matched) return P("not-verbose");

    // Tool-specific already-bounded checks layered on top of the generic
    // BOUND_FLAG_RE. Catches native limit syntaxes like `git log -20` and
    // `tree -L 2` that don't match the generic -n<digits> / --max-count
    // family.
    const extra = EXTRA_BOUND_CHECKS[matched];
    if (extra && extra.test(canonical)) return P("explicit-bound");

    if (cfg.bash.disabled_commands.includes(matched)) {
      return P("user-disabled");
    }

    const bounded = `set -o pipefail; ${command} | awk 'NR<=${head_limit}'`;
    const hint = NATIVE_HINT[matched] ?? "command-specific bound flags";
    return {
      kind: "bound",
      updatedInput: { ...toolInput, command: bounded },
      additionalContext:
        `[tokenomy: bounded ${matched} output to ${head_limit} lines. ` +
        `Re-run with ${hint} if you need more.]`,
      originalCommand: rawCommand,
      boundedCommand: bounded,
      patternName: matched,
      reason: `bash-bound:${matched}`,
    };
  } catch {
    return P("rule-error");
  }
};
