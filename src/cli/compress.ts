import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { compressDeterministic, containsNulByte } from "../compress/deterministic.js";
import { compressWithLocalClaude } from "../compress/llm.js";
import { atomicWrite } from "../util/atomic.js";

interface CompressArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

const MAX_BYTES = 1_000_000;
const CANDIDATE_NAMES = new Set([
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  "AI.md",
  "copilot-instructions.md",
]);
const CANDIDATE_DIR_PARTS = new Set([".cursor", ".windsurf", ".cline", ".roo", ".github"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".tokenomy"]);

const USAGE = `Usage:
  tokenomy compress <file> [--llm] [--dry-run] [--diff] [--in-place] [--force]
  tokenomy compress status
  tokenomy compress restore <file>
`;

const parseArgs = (argv: string[]): CompressArgs => {
  const out: CompressArgs = { _: [], flags: {} };
  for (const arg of argv) {
    if (arg.startsWith("--")) out.flags[arg.slice(2)] = true;
    else out._.push(arg);
  }
  return out;
};

const isInsideCwd = (path: string): boolean => {
  const rel = relative(process.cwd(), path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
};

const backupPathFor = (file: string): string => `${file}.original.md`;

const displayPath = (path: string): string => relative(process.cwd(), path) || path;

const readCompressibleFile = (file: string, force: boolean): Buffer => {
  const full = resolve(file);
  if (!isInsideCwd(full) && !force) {
    throw new Error(`Refusing to compress outside cwd: ${full} (pass --force to override).`);
  }
  if (!existsSync(full)) throw new Error(`File not found: ${full}`);
  const st = statSync(full);
  if (!st.isFile()) throw new Error(`Not a file: ${full}`);
  if (st.size > MAX_BYTES) throw new Error(`Refusing to compress files over 1 MB: ${full}`);
  const buf = readFileSync(full);
  if (containsNulByte(buf)) throw new Error(`Refusing to compress binary-looking file: ${full}`);
  return buf;
};

const renderDiff = (before: string, after: string): string => {
  const a = before.split("\n");
  const b = after.split("\n");
  const out = ["--- before", "+++ after"];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`-${a[i]}`);
    if (b[i] !== undefined) out.push(`+${b[i]}`);
  }
  return out.join("\n") + "\n";
};

const shouldConsider = (path: string): boolean => {
  if (!path.endsWith(".md") && !path.endsWith(".mdc")) return false;
  if (CANDIDATE_NAMES.has(basename(path))) return true;
  return path.split("/").some((part) => CANDIDATE_DIR_PARTS.has(part));
};

const walkCandidates = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkCandidates(resolve(dir, entry.name), out);
      continue;
    }
    const full = resolve(dir, entry.name);
    if (shouldConsider(relative(process.cwd(), full))) out.push(full);
  }
  return out;
};

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const runStatus = (): number => {
  const candidates = walkCandidates(process.cwd())
    .map((path) => ({ path, bytes: statSync(path).size }))
    .filter((entry) => entry.bytes > 0 && entry.bytes <= MAX_BYTES)
    .sort((a, b) => b.bytes - a.bytes);
  if (candidates.length === 0) {
    process.stdout.write("No candidate agent instruction files found.\n");
    return 0;
  }
  for (const candidate of candidates) {
    process.stdout.write(`${displayPath(candidate.path)}\t${candidate.bytes} bytes\n`);
  }
  return 0;
};

const runRestore = (file: string | undefined): number => {
  if (!file) {
    process.stderr.write(USAGE);
    return 1;
  }
  const full = resolve(file);
  const backup = backupPathFor(full);
  if (!existsSync(backup)) throw new Error(`Backup not found: ${backup}`);
  renameSync(backup, full);
  process.stdout.write(`Restored ${displayPath(full)}\n`);
  return 0;
};

const runFile = (file: string | undefined, flags: Record<string, string | boolean>): number => {
  if (!file) {
    process.stderr.write(USAGE);
    return 1;
  }
  const full = resolve(file);
  const before = readCompressibleFile(full, flags["force"] === true).toString("utf8");
  let result = compressDeterministic(before);
  if (flags["llm"] === true) {
    const llm = compressWithLocalClaude(result.text);
    if (llm.ok) result = compressDeterministic(llm.text);
    else process.stderr.write(`tokenomy compress: LLM skipped (${llm.reason}).\n`);
  }
  if (flags["diff"] === true) process.stdout.write(renderDiff(before, result.text));
  process.stdout.write(
    `bytes: ${result.stats.bytesIn} -> ${result.stats.bytesOut} ` +
      `(-${result.stats.bytesSaved}, ${pct(result.stats.pctSaved)})\n`,
  );
  if (flags["dry-run"] === true || flags["diff"] === true || flags["in-place"] !== true) {
    return 0;
  }

  const backup = backupPathFor(full);
  if (!existsSync(backup)) {
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, before);
  }
  atomicWrite(full, result.text);
  process.stdout.write(`Compressed ${displayPath(full)}; backup ${displayPath(backup)}\n`);
  return 0;
};

export const runCompress = (argv: string[]): number => {
  const args = parseArgs(argv);
  const sub = args._[0];
  if (!sub || sub === "help") {
    process.stdout.write(USAGE);
    return sub ? 0 : 1;
  }
  if (sub === "status") return runStatus();
  if (sub === "restore") return runRestore(args._[1]);
  return runFile(sub, args.flags);
};

