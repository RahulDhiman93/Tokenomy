import { spawnSync } from "node:child_process";
import { get } from "node:https";
import type { FailOpen } from "../graph/types.js";

// Thin wrapper over npm registry search. Used by the `find_oss_alternatives`
// MCP tool to surface ranked, well-maintained libraries before the agent
// reimplements functionality from scratch.
//
// Design notes:
// - Direct registry HTTP first because the npm CLI no longer exposes
//   score/searchScore in `npm search --json`.
// - CLI fallback stays in place for offline/corporate-proxy environments where
//   `npm search` might still work through local npm configuration.
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

// npm registry search object shape. The CLI fallback is accepted too: some npm
// versions return the same nested package/score object, while newer versions
// flatten package fields and omit score data.
interface NpmSearchEntry {
  package?: {
    name?: string;
    version?: string;
    description?: string;
    keywords?: string[];
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

interface NpmRegistrySearchResponse {
  objects?: NpmSearchEntry[];
}

interface NpmRegistryQueryResponse {
  query: string;
  weight: number;
  entries: NpmSearchEntry[];
}

interface NpmCandidate {
  entry: OssAlternative;
  raw: NpmSearchEntry;
  aggregate: number;
  downloads?: number;
}

interface SearchDeadline {
  expiresAt: number;
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

const normalizeEntry = (raw: NpmSearchEntry, normalizedFinal?: number): OssAlternative | null => {
  const name = readField<string>(raw, "name");
  if (typeof name !== "string" || name.length === 0) return null;
  const version = readField<string>(raw, "version") ?? "unknown";
  const description = readField<string>(raw, "description") ?? "";
  const final = normalizedFinal ?? raw.score?.final ?? 0.5;
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

const remainingMs = (deadline: SearchDeadline): number =>
  Math.max(0, deadline.expiresAt - Date.now());

type FetchText = typeof fetchText;

let npmRegistryFetchText: FetchText = fetchText;
const npmDownloadCache = new Map<string, number | null>();

export const _setNpmSearchFetchForTests = (fn?: FetchText): void => {
  npmRegistryFetchText = fn ?? fetchText;
  npmDownloadCache.clear();
};

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

const parseCandidates = (
  rawEntries: NpmSearchEntry[],
  opts: NpmSearchOptions,
): Array<{ entry: OssAlternative; raw: NpmSearchEntry }> => {
  const candidates: Array<{ entry: OssAlternative; raw: NpmSearchEntry }> = [];
  const maxFinal = Math.max(0, ...rawEntries.map((entry) => entry.score?.final ?? 0));
  for (let i = 0; i < rawEntries.length; i++) {
    const rawEntry = rawEntries[i];
    if (!rawEntry) continue;
    const normalizedFinal =
      maxFinal > 1 && rawEntry.score?.final !== undefined
        ? rawEntry.score.final / maxFinal
        : undefined;
    const entry = normalizeEntry(rawEntry, normalizedFinal);
    if (!entry) continue;
    if (!filterJunk(entry, rawEntry)) continue;
    if (!passesDownloadProxy(entry, opts.minWeeklyDownloads)) continue;
    candidates.push({ entry, raw: rawEntry });
  }
  return candidates;
};

const rankedResult = (entries: OssAlternative[], entriesRaw: NpmSearchEntry[], opts: NpmSearchOptions): NpmSearchOk => {
  const ranked = rank(entries, entriesRaw);
  const cap = Math.max(1, Math.min(opts.maxResults, 10));
  return { ok: true, results: ranked.slice(0, cap) };
};

const parseRankedEntries = (
  rawEntries: NpmSearchEntry[],
  opts: NpmSearchOptions,
): NpmSearchOk => {
  const candidates = parseCandidates(rawEntries, opts);
  return rankedResult(
    candidates.map((candidate) => candidate.entry),
    candidates.map((candidate) => candidate.raw),
    opts,
  );
};

const parseRegistryBody = (body: string): NpmSearchEntry[] | FailOpen => {
  let raw: unknown;
  try {
    raw = JSON.parse(body) as NpmRegistrySearchResponse;
  } catch {
    return fail("registry-bad-json", "npm registry search returned unparseable JSON");
  }
  if (!raw || typeof raw !== "object") {
    return fail("registry-bad-shape", "expected objects array from npm registry search");
  }
  const objects = (raw as NpmRegistrySearchResponse).objects;
  if (!Array.isArray(objects)) {
    return fail("registry-bad-shape", "expected objects array from npm registry search");
  }
  return objects;
};

const tokenizeQuery = (query: string): string[] => {
  const stop = new Set([
    "a",
    "an",
    "and",
    "for",
    "from",
    "in",
    "of",
    "on",
    "or",
    "the",
    "to",
    "with",
  ]);
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && !stop.has(part));
};

const pushUnique = (items: string[], value: string): void => {
  if (!items.includes(value)) items.push(value);
};

const buildNpmRegistryQueries = (query: string): Array<{ query: string; weight: number }> => {
  const variants: string[] = [];
  const tokens = tokenizeQuery(query);
  const tokenSet = new Set(tokens);
  const compact = tokens.join(" ");
  pushUnique(variants, query);
  if (compact && compact !== query.toLowerCase()) pushUnique(variants, compact);

  // Adjacent-token concatenations ("deep merge" → "deepmerge", "rate limit" →
  // "ratelimit") — many canonical npm packages are named as a single joined
  // word even when the concept is universally spoken as two. Without this,
  // the registry's text-match ranker sends `deepmerge`, `ratelimit`, etc. to
  // the back of the list.
  for (let i = 0; i < tokens.length - 1 && variants.length < 8; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (a.length >= 3 && b.length >= 3) pushUnique(variants, `${a}${b}`);
  }

  if (tokenSet.has("retry") || tokenSet.has("backoff")) {
    pushUnique(variants, "async retry backoff");
    pushUnique(variants, "promise retry backoff");
    if (tokenSet.has("backoff")) pushUnique(variants, "keywords:backoff");
    pushUnique(variants, "keywords:retry");
  }

  if (tokenSet.has("http") || tokenSet.has("fetch") || tokenSet.has("request")) {
    if (tokenSet.has("client")) pushUnique(variants, "keywords:http client");
    pushUnique(variants, "keywords:http");
    pushUnique(variants, "keywords:fetch");
    pushUnique(variants, "http request");
    pushUnique(variants, "fetch http client");
  }

  return variants.slice(0, 8).map((variant, index) => ({
    query: variant,
    weight: index === 0 ? 1.15 : 1,
  }));
};

const npmRegistrySearchUrl = (query: string): string =>
  `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=20`;

const npmDownloadsUrl = (name: string): string =>
  `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`;

const fetchDownloadCount = async (
  name: string,
  deadline: SearchDeadline,
): Promise<number | null> => {
  if (npmDownloadCache.has(name)) return npmDownloadCache.get(name) ?? null;
  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) return null;
  const body = await npmRegistryFetchText(npmDownloadsUrl(name), timeoutMs);
  if (!body) {
    npmDownloadCache.set(name, null);
    return null;
  }
  try {
    const parsed = JSON.parse(body) as { downloads?: unknown };
    const downloads =
      typeof parsed.downloads === "number" && Number.isFinite(parsed.downloads)
        ? parsed.downloads
        : null;
    npmDownloadCache.set(name, downloads);
    return downloads;
  } catch {
    npmDownloadCache.set(name, null);
    return null;
  }
};

// Known big-vendor scopes. Packages under these scopes are usually vendor-SDK
// fragments that happen to keyword-match a general utility query. We penalize
// them unless the query mentions any part of the vendor name.
const VENDOR_SCOPES: ReadonlySet<string> = new Set([
  "@aws-amplify",
  "@aws-cdk",
  "@aws-sdk",
  "@google-cloud",
  "@google-ai",
  "@azure",
  "@microsoft",
  "@oracle",
  "@cloudflare",
  "@alibaba-cloud",
  "@tencent-cloud",
  "@huaweicloud",
  "@sap",
  "@ibm",
  "@salesforce",
]);

const scoreIntentPenalty = (name: string, queryTokens: Set<string>): number => {
  let penalty = 1;
  if (name.startsWith("@")) {
    penalty *= 0.8;
    const slash = name.indexOf("/");
    const scope = slash > 0 ? name.slice(0, slash) : name;
    if (VENDOR_SCOPES.has(scope)) {
      const vendorWords = scope.slice(1).split("-");
      const mentioned = vendorWords.some((word) => queryTokens.has(word));
      if (!mentioned) penalty *= 0.5;
    }
  }
  if (!queryTokens.has("cli") && /(?:^|[-_/])cli(?:$|[-_/])/.test(name)) penalty *= 0.65;
  if (queryTokens.has("retry") && !name.toLowerCase().includes("retry")) penalty *= 0.85;
  return penalty;
};

const rankRegistryResponses = async (
  originalQuery: string,
  responses: NpmRegistryQueryResponse[],
  opts: NpmSearchOptions,
  deadline: SearchDeadline,
): Promise<NpmSearchOk> => {
  const byName = new Map<string, NpmCandidate>();
  for (const response of responses) {
    const candidates = parseCandidates(response.entries, opts);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      if (!candidate) continue;
      const key = candidate.entry.name.toLowerCase();
      const aggregate = response.weight / (i + 4);
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { ...candidate, aggregate });
      } else {
        existing.aggregate += aggregate;
        if (candidate.entry.score.overall > existing.entry.score.overall) {
          existing.entry = candidate.entry;
          existing.raw = candidate.raw;
        }
      }
    }
  }

  const candidates = [...byName.values()];
  candidates.sort((a, b) => b.aggregate - a.aggregate);
  const enrichmentPool = candidates.slice(0, 15);
  for (let i = 0; i < enrichmentPool.length; i += 4) {
    if (remainingMs(deadline) <= 0) break;
    await Promise.all(
      enrichmentPool.slice(i, i + 4).map(async (candidate) => {
        const downloads = await fetchDownloadCount(candidate.entry.name, deadline);
        if (downloads !== null) candidate.downloads = downloads;
      }),
    );
  }

  const maxDownloadLog = Math.max(
    0,
    ...enrichmentPool.map((candidate) => Math.log1p(candidate.downloads ?? 0)),
  );
  const queryTokens = new Set(tokenizeQuery(originalQuery));
  const scored = candidates.map((candidate) => {
    const downloadScore =
      maxDownloadLog > 0 && candidate.downloads !== undefined
        ? Math.log1p(candidate.downloads) / maxDownloadLog
        : candidate.entry.score.popularity;
    const key =
      (candidate.aggregate * 0.65 + downloadScore * 0.35) *
      scoreIntentPenalty(candidate.entry.name, queryTokens);
    return { candidate, key, downloadScore };
  });
  scored.sort((a, b) => b.key - a.key);

  const maxKey = Math.max(0, ...scored.map((item) => item.key));
  const cap = Math.max(1, Math.min(opts.maxResults, 10));
  return {
    ok: true,
    results: scored.slice(0, cap).map(({ candidate, key, downloadScore }) => {
      const overall = Math.max(
        maxKey > 0 ? key / maxKey : 0,
        candidate.entry.score.overall,
      );
      return {
        ...candidate.entry,
        score: {
          ...candidate.entry.score,
          overall,
          popularity: downloadScore,
        },
        fit_reason: buildFitReason(
          candidate.entry.score.quality,
          downloadScore,
          candidate.entry.score.maintenance,
        ),
      };
    }),
  };
};

const searchNpmRegistry = async (
  query: string,
  opts: NpmSearchOptions,
): Promise<NpmSearchResult> => {
  const deadline = { expiresAt: Date.now() + opts.timeoutMs };
  const queries = buildNpmRegistryQueries(query);
  const fetched = await Promise.all(
    queries.map(async (searchQuery) => {
      const timeoutMs = remainingMs(deadline);
      if (timeoutMs <= 0) return null;
      const body = await npmRegistryFetchText(npmRegistrySearchUrl(searchQuery.query), timeoutMs);
      if (!body) return null;
      const entries = parseRegistryBody(body);
      return Array.isArray(entries) ? { ...searchQuery, entries } : entries;
    }),
  );
  const failures = fetched.filter(
    (item): item is FailOpen => !!item && "ok" in item && item.ok === false,
  );
  const responses = fetched.filter(
    (item): item is NpmRegistryQueryResponse => !!item && !("ok" in item),
  );
  if (responses.length === 0) {
    if (failures[0]) return failures[0];
    return fail(
      "registry-unavailable",
      "npm registry search did not return results; falling back to npm CLI.",
    );
  }
  return rankRegistryResponses(query, responses, opts, deadline);
};

const searchNpmCli = (query: string, opts: NpmSearchOptions): NpmSearchResult => {
  let r;
  try {
    r = spawnSync("npm", ["search", "--json", query], {
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

  return parseRankedEntries(raw as NpmSearchEntry[], opts);
};

const shouldFallbackToCli = (result: NpmSearchResult): boolean =>
  !result.ok &&
  (result.reason === "registry-unavailable" ||
    result.reason === "registry-bad-json" ||
    result.reason === "registry-bad-shape");

export const npmSearch = async (
  query: string,
  opts: NpmSearchOptions,
): Promise<NpmSearchResult> => {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return fail("invalid-input", "description must be a non-empty string");
  }

  const registry = await searchNpmRegistry(trimmed, opts);
  if (!shouldFallbackToCli(registry)) return registry;
  return searchNpmCli(trimmed, opts);
};
