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
];

export function detectSource(url: string): SourceId | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return HOSTS.find(([re]) => re.test(host))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Params that only track you or pin UI state; they never change results. */
const JUNK_PARAMS: Partial<Record<SourceId | "*", string[]>> = {
  "*": ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "ref", "referrer"],
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
} as const;

const INDEED_DOMAINS: Record<string, string> = {
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
  if (q.remoteOnly) attrs.push(`attr(${INDEED_ATTR.remote})`);
  if (attrs.length) parts.push(`sc=${encodeURIComponent(`0kf:${attrs.join("")};`)}`);
  parts.push("sort=date");
  if (start) parts.push(`start=${start}`);
  return `https://${host}/jobs?${parts.join("&")}`;
}
