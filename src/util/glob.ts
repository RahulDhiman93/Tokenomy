// Gitignore-style path globbing. Intentionally limited:
//   **   any sequence including `/` (zero or more path segments)
//   *    any sequence within a single path segment (no `/`)
//   ?    single non-`/` char
//   else literal (regex metachars auto-escaped)
// Case-sensitive. Anchored to the full posix path. No negation, no braces,
// no character classes - scope-creep, easy to add later behind the same entry.

// Placeholders from the Unicode Private Use Area: never valid in real file
// paths and not regex metacharacters, so we can swap glob tokens out before
// escaping the rest as literal regex, then swap back to the expanded form.
const PH0 = "";
const PH1 = "";
const PH2 = "";
const PH3 = "";
const PH4 = "";

// 0.1.10+ P8b: glob compile caps. Reject pathological patterns
// before they become ReDoS-amenable regexes. A user-supplied
// `**a**a**a**a**a**a` pattern compiled to `.*a.*a.*a.*a.*a.*` is
// catastrophically slow on near-matching inputs; capping length +
// `*` count keeps the matcher linear in practice.
const MAX_GLOB_LENGTH = 256;
const MAX_GLOB_STARS = 16;

export class GlobCompileError extends Error {
  readonly pattern: string;
  constructor(pattern: string, reason: string) {
    super(`glob "${pattern}" rejected: ${reason}`);
    this.name = "GlobCompileError";
    this.pattern = pattern;
  }
}

export const globToPathRegex = (glob: string): RegExp => {
  if (glob.length > MAX_GLOB_LENGTH) {
    throw new GlobCompileError(glob, `length ${glob.length} > ${MAX_GLOB_LENGTH}`);
  }
  let stars = 0;
  for (let i = 0; i < glob.length; i++) {
    if (glob.charCodeAt(i) === 0x2a /* * */) stars++;
  }
  if (stars > MAX_GLOB_STARS) {
    throw new GlobCompileError(glob, `${stars} '*' chars > ${MAX_GLOB_STARS}`);
  }
  let src = glob
    .replace(/\*\*\//g, PH0)
    .replace(/\/\*\*/g, PH1)
    .replace(/\*\*/g, PH2)
    .replace(/\*/g, PH3)
    .replace(/\?/g, PH4);
  src = src.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  src = src
    .replaceAll(PH0, "(?:.*/)?")
    .replaceAll(PH1, "(?:/.*)?")
    .replaceAll(PH2, ".*")
    .replaceAll(PH3, "[^/]*")
    .replaceAll(PH4, "[^/]");
  return new RegExp(`^${src}$`);
};

export const compileGlobs = (patterns: string[]): RegExp[] => {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(globToPathRegex(p));
    } catch (e) {
      // 0.1.10+ P8b: log + skip pathological patterns rather than
      // crashing the whole enumerate. A bad cfg.graph.exclude entry
      // is a config error, not a runtime failure.
      if (e instanceof GlobCompileError) {
        process.stderr.write(`[tokenomy] ${e.message}\n`);
        continue;
      }
      throw e;
    }
  }
  return out;
};

export const matchesAny = (posixPath: string, compiled: RegExp[]): boolean => {
  for (const re of compiled) {
    if (re.test(posixPath)) return true;
  }
  return false;
};

export const matchesAnyGlob = (posixPath: string, patterns: string[]): boolean =>
  matchesAny(posixPath, compileGlobs(patterns));
