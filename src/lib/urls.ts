import type { EmploymentType, SearchQuery, SourceId } from "../model.ts";

const HOSTS: [RegExp, SourceId][] = [
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)indeed\.[a-z.]+$/, "indeed"],
  [/(^|\.)glassdoor\.[a-z.]+$/, "glassdoor"],
  [/(^|\.)(wellfound|angel)\.(com|co)$/, "wellfound"],
  [/(^|\.)upwork\.com$/, "upwork"],
  [/(^|\.)ziprecruiter\.[a-z.]+$/, "ziprecruiter"],
  [/(^|\.)dice\.com$/, "dice"],
  [/(^|\.)monster\.[a-z.]+$/, "monster"],
  [/(^|\.)simplyhired\.[a-z.]+$/, "simplyhired"],
  [/(^|\.)remoteok\.(com|io)$/, "remoteok"],
  [/(^|\.)builtin[a-z]*\.com$/, "builtin"],
  [/(^|\.)greenhouse\.io$/, "greenhouse"],
  [/(^|\.)lever\.co$/, "lever"],
  [/(^|\.)ashbyhq\.com$/, "ashby"],
  [/(^|\.)smartrecruiters\.com$/, "smartrecruiters"],
  [/(^|\.)myworkdayjobs\.com$|(^|\.)workday\.com$/, "workday"],
  [/(^|\.)jobvite\.com$/, "jobvite"],
  [/(^|\.)workable\.com$/, "workable"],
  [/(^|\.)breezy\.hr$/, "breezy"],
  [/(^|\.)recruitee\.com$/, "recruitee"],
];

const DIRECT_ATS_HOSTS = [
  /(^|\.)greenhouse\.io$/,
  /(^|\.)lever\.co$/,
  /(^|\.)ashbyhq\.com$/,
  /(^|\.)smartrecruiters\.com$/,
  /(^|\.)myworkdayjobs\.com$/,
  /(^|\.)workday\.com$/,
  /(^|\.)jobvite\.com$/,
  /(^|\.)workable\.com$/,
  /(^|\.)breezy\.hr$/,
  /(^|\.)recruitee\.com$/,
  /(^|\.)icims\.com$/,
  /(^|\.)taleo\.net$/,
  /(^|\.)bamboohr\.com$/,
  /(^|\.)rippling\.com$/,
];

export function detectSource(url: string): SourceId | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Checks if a URL points directly to an ATS applicant portal vs a third-party job board aggregator.
 */
export function isDirectApplyUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url.trim()).hostname.toLowerCase();
    return DIRECT_ATS_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

/** Params that only track you or pin UI state; they never change results. */
const JUNK_PARAMS: Partial<Record<SourceId | "*", string[]>> = {
  "*": [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "gclid",
    "fbclid",
    "ref",
    "refId",
    "referrer",
    "mc_cid",
    "mc_eid",
    "sessionId",
  ],
  indeed: ["vjk", "from", "advn", "jk", "tk", "pp", "iafilter", "cf-turnstile-response"],
  linkedin: ["currentJobId", "trk", "trackingId", "refId", "origin", "originalSubdomain", "lipi", "position", "pageNum", "eBP"],
  glassdoor: ["src", "srs", "suggestCount", "suggestChosen", "clickSource", "jl", "ao", "s", "guid", "pos", "t", "vt", "uido"],
  wellfound: [],
  upwork: ["nbs", "from_recent_search", "ontology_skill_uid"],
  ziprecruiter: ["form", "lvk", "uuid", "zrclid", "page_referrer"],
  dice: ["searchId", "sid", "countryCode2"],
  monster: ["id", "stpage", "page"],
  simplyhired: ["job", "cursor"],
  remoteok: [],
  builtin: [],
  greenhouse: ["gh_jid", "gh_src"],
  lever: ["mode"],
  ashby: [],
};

/** Strip tracking/UI params so a pasted browser URL is safe to use as an actor startUrl. */
export function cleanUrl(input: string): { url: string; source: SourceId | null; removed: string[] } {
  const u = new URL(input.trim());
  const source = detectSource(u.toString());
  const junk = new Set([...(JUNK_PARAMS["*"] ?? []), ...(source ? (JUNK_PARAMS[source] ?? []) : [])]);
  const removed: string[] = [];

  // Rebuild the query string by hand so already-encoded values (Indeed's
  // double-encoded `sc=` filter) are preserved byte-for-byte.
  const kept = u.search
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .filter((pair) => {
      const key = decodeURIComponent(pair.split("=")[0]!);
      if (junk.has(key)) {
        removed.push(key);
        return false;
      }
      return true;
    });

  const url = `${u.origin}${u.pathname}${kept.length ? `?${kept.join("&")}` : ""}`;
  return { url, source, removed };
}

/**
 * Extract canonical job ID from known board URLs.
 */
export function extractJobIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase();

    // LinkedIn
    if (host.includes("linkedin.com")) {
      const match = u.pathname.match(/\/jobs\/view\/(\d+)/) || u.search.match(/[?&]currentJobId=(\d+)/);
      if (match) return match[1]!;
    }

    // Indeed
    if (host.includes("indeed.com")) {
      const jk = u.searchParams.get("jk");
      if (jk) return jk;
      const match = u.pathname.match(/\/viewjob.*?([a-f0-9]{16})/i) || u.pathname.match(/\/rc\/clk.*?([a-f0-9]{16})/i);
      if (match) return match[1]!;
    }

    // Greenhouse
    if (host.includes("greenhouse.io")) {
      const match = u.pathname.match(/\/jobs\/(\d+)/) || u.search.match(/[?&]gh_jid=(\d+)/);
      if (match) return match[1]!;
    }

    // Lever
    if (host.includes("lever.co")) {
      const match = u.pathname.match(/\/([a-f0-9-]{36})/i);
      if (match) return match[1]!;
    }

    // Ashby
    if (host.includes("ashbyhq.com")) {
      const match = u.pathname.match(/\/([a-f0-9-]{36})/i);
      if (match) return match[1]!;
    }

    // SmartRecruiters
    if (host.includes("smartrecruiters.com")) {
      const match = u.pathname.match(/\/([a-f0-9-]{36}|\d+)(?:\/|\?|$)/i);
      if (match) return match[1]!;
    }

    // Upwork
    if (host.includes("upwork.com")) {
      const match = u.pathname.match(/(~[a-zA-Z0-9]+)/);
      if (match) return match[1]!;
    }

    // ZipRecruiter
    if (host.includes("ziprecruiter.com")) {
      const jid = u.searchParams.get("jid");
      if (jid) return jid;
      const match = u.pathname.match(/\/jobs\/([^/?#]+)/);
      if (match) return match[1]!;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Standardize job URLs into their canonical form for deduplication.
 */
export function canonicalJobUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const u = new URL(trimmed);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");

    // LinkedIn
    if (host.includes("linkedin.com")) {
      const id = extractJobIdFromUrl(trimmed);
      if (id) return `https://www.linkedin.com/jobs/view/${id}`;
    }

    // Indeed
    if (host.includes("indeed.com")) {
      const id = extractJobIdFromUrl(trimmed);
      if (id) return `https://www.indeed.com/viewjob?jk=${id}`;
    }

    // Greenhouse
    if (host.includes("greenhouse.io")) {
      const ghMatch = u.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
      if (ghMatch) {
        return `https://boards.greenhouse.io/${ghMatch[1]}/jobs/${ghMatch[2]}`;
      }
    }

    // Lever
    if (host.includes("lever.co")) {
      const leverMatch = u.pathname.match(/\/([^/]+)\/([a-f0-9-]{36})/i);
      if (leverMatch) {
        return `https://jobs.lever.co/${leverMatch[1]}/${leverMatch[2]}`;
      }
    }

    // Ashby
    if (host.includes("ashbyhq.com")) {
      const ashbyMatch = u.pathname.match(/\/([^/]+)\/([a-f0-9-]{36})/i);
      if (ashbyMatch) {
        return `https://jobs.ashbyhq.com/${ashbyMatch[1]}/${ashbyMatch[2]}`;
      }
    }

    // ZipRecruiter
    if (host.includes("ziprecruiter.com")) {
      const jid = u.searchParams.get("jid");
      if (jid) return `https://www.ziprecruiter.com/jobs/${jid}`;
    }

    // Clean standard tracking params
    const { url } = cleanUrl(trimmed);
    const cleanedUrl = new URL(url);
    cleanedUrl.protocol = "https:";
    cleanedUrl.hash = "";
    if (cleanedUrl.pathname.length > 1 && cleanedUrl.pathname.endsWith("/")) {
      cleanedUrl.pathname = cleanedUrl.pathname.slice(0, -1);
    }
    return cleanedUrl.toString();
  } catch {
    return null;
  }
}

export const normalizeUrl = canonicalJobUrl;

/**
 * Extract clean root domain / hostname.
 */
export function getDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Resolves relative URLs against a base URL.
 */
export function absUrl(u: string | null, base: string): string | null {
  if (!u) return null;
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Indeed URL builder. Indeed's own filters are richer than any actor's input
// schema, so we generate a real search URL and hand that to the actor.
// ---------------------------------------------------------------------------

/**
 * Indeed "attr" codes used in the `sc=0kf:attr(...)` filter.
 * SimplyHired (owned by Indeed) uses the exact same codes for job type.
 */
export const INDEED_ATTR = {
  full_time: "CF3CP",
  part_time: "75GKK",
  contract: "NJXCK",
  temporary: "4HKF7",
  internship: "VDTG7",
  remote: "DSQF7",
  hybrid: "PA55J",
  onsite: "7WFD7",
  direct_apply: "HFDN6",
  senior_level: "EXSNN",
  mid_level: "5Q6K6",
  entry_level: "FC296",
} as const;

export const INDEED_DOMAINS: Record<string, string> = {
  US: "www.indeed.com",
  CA: "ca.indeed.com",
  GB: "uk.indeed.com",
  UK: "uk.indeed.com",
  AU: "au.indeed.com",
  IE: "ie.indeed.com",
  IN: "in.indeed.com",
  DE: "de.indeed.com",
  FR: "fr.indeed.com",
  NL: "nl.indeed.com",
  SG: "sg.indeed.com",
  MX: "mx.indeed.com",
};

export function indeedTypeCodes(types: EmploymentType[] | undefined): string[] {
  return (types ?? [])
    .map((t): string | undefined => (t === "freelance" ? INDEED_ATTR.contract : INDEED_ATTR[t as keyof typeof INDEED_ATTR]))
    .filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
}

export function buildIndeedUrl(q: SearchQuery, start = 0): string {
  const host = INDEED_DOMAINS[(q.country ?? "US").toUpperCase()] ?? "www.indeed.com";
  const parts: string[] = [
    `q=${encodeURIComponent(q.keywords ?? "").replace(/%20/g, "+")}`,
    `l=${encodeURIComponent(q.location ?? "").replace(/%20/g, "+")}`,
  ];
  if (q.radiusMiles != null) parts.push(`radius=${q.radiusMiles}`);
  if (q.minSalary) parts.push(`salaryType=${encodeURIComponent(`$${q.minSalary.toLocaleString("en-US")}+`)}`);
  if (q.postedWithinDays) parts.push(`fromage=${q.postedWithinDays}`);

  const attrs: string[] = [];
  const typeCodes = indeedTypeCodes(q.employmentTypes);
  // Several job types are OR'ed: attr(A|B|C,OR)  — the comma is double-encoded by Indeed.
  if (typeCodes.length === 1) attrs.push(`attr(${typeCodes[0]})`);
  if (typeCodes.length > 1) attrs.push(`attr(${typeCodes.join("|")}%2COR)`);
  if (q.remoteOnly || q.workModes?.includes("remote")) attrs.push(`attr(${INDEED_ATTR.remote})`);
  if (q.workModes?.includes("hybrid")) attrs.push(`attr(${INDEED_ATTR.hybrid})`);
  if (q.workModes?.includes("onsite")) attrs.push(`attr(${INDEED_ATTR.onsite})`);
  if (q.directApplyOnly) attrs.push(`attr(${INDEED_ATTR.direct_apply})`);

  // Native Indeed seniority attribute mappings
  if (q.seniorityLevels?.length) {
    const senCodes: string[] = [];
    if (q.seniorityLevels.some((s) => ["senior", "lead", "staff", "principal", "director", "executive"].includes(s))) {
      senCodes.push(INDEED_ATTR.senior_level);
    }
    if (q.seniorityLevels.includes("mid")) {
      senCodes.push(INDEED_ATTR.mid_level);
    }
    if (q.seniorityLevels.some((s) => ["entry", "intern"].includes(s))) {
      senCodes.push(INDEED_ATTR.entry_level);
    }
    if (senCodes.length === 1) attrs.push(`attr(${senCodes[0]})`);
    if (senCodes.length > 1) attrs.push(`attr(${senCodes.join("|")}%2COR)`);
  }

  if (attrs.length) parts.push(`sc=${encodeURIComponent(`0kf:${attrs.join("")};`)}`);
  parts.push("sort=date");
  if (start) parts.push(`start=${start}`);
  return `https://${host}/jobs?${parts.join("&")}`;
}
