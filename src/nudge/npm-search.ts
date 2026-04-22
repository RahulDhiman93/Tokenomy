import { spawnSync } from "node:child_process";
import { get } from "node:https";
import type { FailOpen } from "../graph/types.js";

// Thin, sync wrapper over `npm search --json <query>`. Used by the
// `find_oss_alternatives` MCP tool to surface ranked, well-maintained
// libraries before the agent reimplements functionality from scratch.
//
// Design notes:
// - Subprocess rather than direct HTTP: matches the existing precedent at
//   `src/cli/update.ts` (spawnSync "npm view ...") and avoids introducing a
//   new HTTP client dep. Users already have npm because they install tokenomy.
// - Fail-open everywhere: npm missing / timeout / malformed output all return
//   a structured FailOpen so callers (and the agent) proceed gracefully to a
//   from-scratch implementation.
// - No caching inside this module; the MCP handler caches via QueryCache.

export interface NpmSearchOptions {
  timeoutMs: number;
  minWeeklyDownloads: number;
  maxResults: number;
}

export type OssEcosystem = "npm" | "pypi" | "go" | "maven";

export interface OssAlternative {
  ecosystem: OssEcosystem;
  name: string;
  version: string;
  description: string;
  score: {
    overall: number;
    quality: number;
    popularity: number;
    maintenance: number;
  };
  last_published?: string;
  links?: {
    npm?: string;
    registry?: string;
    homepage?: string;
    repository?: string;
  };
  fit_reason: string;
}

export interface NpmSearchOk {
  ok: true;
  results: OssAlternative[];
}

export type NpmSearchResult = NpmSearchOk | FailOpen;

// npm search --json shape (observed on npm 10.x+). Nested `package` and
// `score` objects; some fields are optional depending on npm version.
interface NpmSearchEntry {
  package?: {
    name?: string;
    version?: string;
    description?: string;
    date?: string;
    links?: { npm?: string; homepage?: string; repository?: string };
  };
  // Some npm versions flatten these onto the entry root instead; handle both.
  name?: string;
  version?: string;
  description?: string;
  date?: string;
  links?: { npm?: string; homepage?: string; repository?: string };
  score?: {
    final?: number;
    detail?: {
      quality?: number;
      popularity?: number;
      maintenance?: number;
    };
  };
  searchScore?: number;
  deprecated?: string | boolean;
}

const fail = (reason: string, hint?: string): FailOpen => ({
  ok: false,
  reason,
  ...(hint ? { hint } : {}),
});

const readField = <T>(entry: NpmSearchEntry, key: keyof NpmSearchEntry): T | undefined => {
  const fromPkg = entry.package?.[key as keyof NonNullable<typeof entry.package>];
  if (fromPkg !== undefined) return fromPkg as T;
  return entry[key] as T | undefined;
};

const normalizeEntry = (raw: NpmSearchEntry): OssAlternative | null => {
  const name = readField<string>(raw, "name");
  if (typeof name !== "string" || name.length === 0) return null;
  const version = readField<string>(raw, "version") ?? "unknown";
  const description = readField<string>(raw, "description") ?? "";
  const final = raw.score?.final ?? 0.5;
  const quality = raw.score?.detail?.quality ?? final;
  const popularity = raw.score?.detail?.popularity ?? final;
  const maintenance = raw.score?.detail?.maintenance ?? final;
  const links = readField<NonNullable<NpmSearchEntry["links"]>>(raw, "links");
  const lastPublished = readField<string>(raw, "date");
  return {
    ecosystem: "npm",
    name,
    version,
    description,
    score: { overall: final, quality, popularity, maintenance },
    ...(lastPublished ? { last_published: lastPublished } : {}),
    ...(links ? { links } : {}),
    fit_reason: buildFitReason(quality, popularity, maintenance),
  };
};

const decodeHtml = (value: string): string =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const fetchText = (url: string, timeoutMs: number): Promise<string | null> =>
  new Promise((resolve) => {
    const req = get(url, { headers: { "user-agent": "tokenomy" } }, (res) => {
      if ((res.statusCode ?? 0) >= 400) {
        res.resume();
        resolve(null);
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });

const registryAlternative = (
  ecosystem: OssEcosystem,
  name: string,
  description: string,
  registry: string,
  version = "unknown",
): OssAlternative => ({
  ecosystem,
  name,
  version,
  description,
  score: { overall: 0.5, quality: 0.5, popularity: 0.5, maintenance: 0.5 },
  links: { registry },
  fit_reason: `${ecosystem} registry search match`,
});

const searchPyPi = async (
  query: string,
  opts: NpmSearchOptions,
): Promise<NpmSearchResult> => {
  const url = `https://pypi.org/search/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, opts.timeoutMs);
  if (!html) return fail("pypi-unavailable", "PyPI search did not return results.");
  const out: OssAlternative[] = [];
  const re =
    /href="\/project\/([^/]+)\/"[\s\S]*?package-snippet__version">([^<]*)[\s\S]*?package-snippet__description">([^<]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < opts.maxResults) {
    const name = decodeHtml(match[1] ?? "").trim();
    if (!name) continue;
    out.push(
      registryAlternative(
        "pypi",
        name,
        decodeHtml(match[3] ?? "").trim(),
        `https://pypi.org/project/${name}/`,
        decodeHtml(match[2] ?? "").trim() || "unknown",
      ),
    );
  }
  return { ok: true, results: out };
};

const searchGo = async (
  query: string,
  opts: NpmSearchOptions,
): Promise<NpmSearchResult> => {
  const url = `https://pkg.go.dev/search?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url, opts.timeoutMs);
  if (!html) return fail("go-unavailable", "pkg.go.dev search did not return results.");
  const seen = new Set<string>();
  const out: OssAlternative[] = [];
  const re = /href="\/([^"]+)"[^>]*>([^<]*(?:github\.com|golang\.org|go\.uber\.org|cloud\.google\.com)[^<]*)<\/a>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < opts.maxResults) {
    const name = decodeHtml(match[1] ?? "").trim();
    if (!name || seen.has(name) || name.startsWith("search?")) continue;
    seen.add(name);
    out.push(registryAlternative("go", name, decodeHtml(match[2] ?? name), `https://pkg.go.dev/${name}`));
  }
  return { ok: true, results: out };
};

const searchMaven = async (
  query: string,
  opts: NpmSearchOptions,
): Promise<NpmSearchResult> => {
  const url =
    `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(query)}` +
    `&rows=${Math.max(1, Math.min(opts.maxResults, 10))}&wt=json`;
  const body = await fetchText(url, opts.timeoutMs);
  if (!body) return fail("maven-unavailable", "Maven Central search did not return results.");
  try {
    const parsed = JSON.parse(body) as {
      response?: { docs?: Array<{ g?: string; a?: string; latestVersion?: string }> };
    };
    const docs = parsed.response?.docs ?? [];
    return {
      ok: true,
      results: docs.map((doc) => {
        const group = doc.g ?? "";
        const artifact = doc.a ?? "";
        const name = group && artifact ? `${group}:${artifact}` : artifact || group;
        return registryAlternative(
          "maven",
          name,
          `Maven artifact ${name}`,
          `https://central.sonatype.com/artifact/${group}/${artifact}`,
          doc.latestVersion ?? "unknown",
        );
      }),
    };
  } catch {
    return fail("maven-bad-json", "Maven Central returned unparseable JSON");
  }
};

export const registrySearch = async (
  ecosystem: Exclude<OssEcosystem, "npm">,
  query: string,
  opts: NpmSearchOptions,
): Promise<NpmSearchResult> => {
  if (ecosystem === "pypi") return searchPyPi(query, opts);
  if (ecosystem === "go") return searchGo(query, opts);
  return searchMaven(query, opts);
};

const buildFitReason = (q: number, p: number, m: number): string => {
  // Deterministic string template — no LLM call, cheap and stable.
  const bits: string[] = [];
  if (m >= 0.7) bits.push("actively maintained");
  else if (m >= 0.4) bits.push("moderately maintained");
  if (p >= 0.7) bits.push("widely adopted");
  else if (p >= 0.4) bits.push("moderate adoption");
  if (q >= 0.7) bits.push("high quality score");
  if (bits.length === 0) bits.push("npm search match");
  return bits.join(", ");
};

// Rank by composite score. `searchScore` captures npm's relevance to the
// query; `score.final` captures npm's quality/popularity/maintenance
// composite. Multiply so both signals count.
const rank = (entries: OssAlternative[], entriesRaw: NpmSearchEntry[]): OssAlternative[] => {
  const withKey = entries.map((entry, i) => {
    const raw = entriesRaw[i];
    const relevance = raw?.searchScore ?? 1 / (i + 1);
    const composite = entry.score.overall;
    return { entry, key: relevance * composite };
  });
  withKey.sort((a, b) => b.key - a.key);
  return withKey.map((w) => w.entry);
};

const filterJunk = (entry: OssAlternative, raw: NpmSearchEntry): boolean => {
  if (raw.deprecated) return false;
  if (entry.score.overall < 0.25) return false;
  if (entry.description.trim().length === 0) return false;
  return true;
};

const popularityFloorForDownloads = (minWeeklyDownloads: number): number => {
  if (minWeeklyDownloads <= 0) return 0;
  if (minWeeklyDownloads >= 1_000_000) return 0.8;
  if (minWeeklyDownloads >= 100_000) return 0.65;
  if (minWeeklyDownloads >= 10_000) return 0.45;
  return 0.25;
};

const passesDownloadProxy = (
  entry: OssAlternative,
  minWeeklyDownloads: number,
): boolean => entry.score.popularity >= popularityFloorForDownloads(minWeeklyDownloads);

export const npmSearch = (query: string, opts: NpmSearchOptions): NpmSearchResult => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return fail("invalid-input", "description must be a non-empty string");
  }
  let r;
  try {
    r = spawnSync("npm", ["search", "--json", trimmed], {
      encoding: "utf8",
      timeout: opts.timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return fail("npm-spawn-failed", (err as Error).message);
  }
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return fail(
      "npm-unavailable",
      "Install `npm` and ensure it's on your PATH, then retry.",
    );
  }
  if (r.signal === "SIGTERM") return fail("timeout");
  if (r.status !== 0 || !r.stdout) {
    return fail("npm-failed", `npm search exited ${r.status ?? "?"}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout);
  } catch {
    return fail("bad-json", "npm search returned unparseable JSON");
  }
  if (!Array.isArray(raw)) return fail("bad-shape", "expected JSON array from npm search");

  const rawEntries = raw as NpmSearchEntry[];
  const normalized: OssAlternative[] = [];
  const rawForRanked: NpmSearchEntry[] = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const rawEntry = rawEntries[i];
    if (!rawEntry) continue;
    const entry = normalizeEntry(rawEntry);
    if (!entry) continue;
    if (!filterJunk(entry, rawEntry)) continue;
    if (!passesDownloadProxy(entry, opts.minWeeklyDownloads)) continue;
    normalized.push(entry);
    rawForRanked.push(rawEntry);
  }

  const ranked = rank(normalized, rawForRanked);
  const cap = Math.max(1, Math.min(opts.maxResults, 10));
  return { ok: true, results: ranked.slice(0, cap) };
};
