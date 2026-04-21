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

export const globToPathRegex = (glob: string): RegExp => {
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

export const compileGlobs = (patterns: string[]): RegExp[] =>
  patterns.map(globToPathRegex);

export const matchesAny = (posixPath: string, compiled: RegExp[]): boolean => {
  for (const re of compiled) {
    if (re.test(posixPath)) return true;
  }
  return false;
};

export const matchesAnyGlob = (posixPath: string, patterns: string[]): boolean =>
  matchesAny(posixPath, compileGlobs(patterns));
