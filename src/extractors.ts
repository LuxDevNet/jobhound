/**
 * Universal extraction engine.
 * Most job sites ship their data as JSON somewhere in the page (JSON-LD,
 * __NEXT_DATA__, Apollo/Nuxt state, window.* blobs, or schema microdata).
 * We pull every blob, walk it, normalize it, and fall back to robust DOM / HTML
 * parsing when structured data is missing or incomplete.
 */
import * as cheerio from "cheerio";
import { absUrl, first, num, str, strArray, stripHtml, type Item } from "./lib/extract.ts";
import { buildSalary } from "./lib/salary.ts";
import { parseDate } from "./lib/dates.ts";
import { detectEmploymentType, detectWorkMode } from "./lib/text.ts";
import type { RawJob } from "./model.ts";

/** Comprehensive HTML entity decoder. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x2B;/gi, "+")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&apos;|&#39;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

/** Tolerant JSON parser that cleans up common formatting oddities. */
export function tryJson(s: string): unknown {
  if (!s || typeof s !== "string") return undefined;
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try decoding HTML entities and stripping trailing commas
    try {
      const decoded = decodeEntities(trimmed);
      return JSON.parse(decoded);
    } catch {
      try {
        const noTrailingCommas = trimmed.replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(noTrailingCommas);
      } catch {
        return undefined;
      }
    }
  }
}

/**
 * Balanced-brace/bracket slicer starting at s[i] === "{" or "[".
 * Handles nested strings (double, single, template literals), escape sequences,
 * and inline/block comments.
 */
export function sliceJson(s: string, i: number): string | null {
  if (i < 0 || i >= s.length) return null;
  const open = s[i];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";

  let depth = 0;
  let inStr: string | null = null;
  let esc = false;
  let inBlockComment = false;
  let inLineComment = false;

  for (let j = i; j < s.length; j++) {
    const c = s[j];
    const next = s[j + 1];

    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        j++;
      }
      continue;
    }
    if (inLineComment) {
      if (c === "\n" || c === "\r") inLineComment = false;
      continue;
    }

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (c === "\\") {
        esc = true;
      } else if (c === inStr) {
        inStr = null;
      }
      continue;
    }

    // Check for comment starts
    if (c === "/" && next === "*") {
      inBlockComment = true;
      j++;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      j++;
      continue;
    }

    // Check for string starts
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }

    if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(i, j + 1);
    }
  }
  return null;
}

/** Flatten JSON-LD graphs and arrays into a flat list of objects. */
function flattenJsonLd(v: unknown): unknown[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(flattenJsonLd);
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const out: unknown[] = [obj];
    if (Array.isArray(obj["@graph"])) {
      out.push(...flattenJsonLd(obj["@graph"]));
    }
    return out;
  }
  return [];
}

/** Extract all JSON-LD blocks from an HTML document. */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld(?:\+|&#x2B;)json[^"']*["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    const parsed = tryJson(raw) ?? tryJson(decodeEntities(raw));
    if (parsed) out.push(...flattenJsonLd(parsed));
  }
  return out;
}

/** All JSON blobs embedded in a page (JSON-LD, script tags, window.* / state assignments). */
export function embeddedJson(html: string): unknown[] {
  const out: unknown[] = [...jsonLdBlocks(html)];

  // Extract application/json script tags (__NEXT_DATA__, SvelteKit, Remix, etc.)
  for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1]?.trim();
    if (raw) {
      const v = tryJson(raw);
      if (v) out.push(v);
    }
  }

  // Common global variable assignments in scripts
  const jsAssignmentRe = /(?:(?:window\.|var\s+|let\s+|const\s+)?(?:__NEXT_DATA__|__INITIAL_STATE__|__APOLLO_STATE__|__PRELOADED_STATE__|__NUXT__|__remixContext|jobData|workday)|window\.[\w$.]+|window\[["'][^"']+["']\]|[\w$.]+\["[\w-]+"\])\s*=\s*(?=[{[])/g;

  const seenBlobs = new Set<string>();
  for (const m of html.matchAll(jsAssignmentRe)) {
    const startIdx = m.index! + m[0].length;
    const blob = sliceJson(html, startIdx);
    if (blob && !seenBlobs.has(blob)) {
      seenBlobs.add(blob);
      const v = tryJson(blob);
      if (v) out.push(v);
    }
  }

  return out;
}

const TITLE_KEYS = [
  "title", "jobTitle", "job_title", "position", "positionTitle", "displayTitle",
  "positionName", "jobTitleText", "role", "headline", "name", "Title", "headlineText",
];

const COMPANY_KEYS = [
  "hiringOrganization.name", "hiringOrganization.legalName", "hiringOrganization.title",
  "hiringOrganization", "company", "companyName", "company_name", "employer.name",
  "employerName", "employerNameFromSearch", "OrgName", "organization.name",
  "organization", "startup.name", "hiringCompany.name", "client.name", "clientName",
  "company.name",
];

const URL_KEYS = [
  "url", "jobUrl", "job_url", "link", "absolute_url", "hostedUrl", "detailsPageUrl",
  "jobLink", "seoJobLink", "viewJobLink", "JobURL", "applyUrl", "directApplyUrl",
  "externalApplyLink", "applicationLink",
];

const REJECTED_TITLES = new Set([
  "search jobs", "career opportunities", "job search", "careers", "sign in", "login",
  "privacy policy", "terms of service", "cookie policy", "404 not found", "access denied",
  "error", "loading", "page not found", "job details", "apply now",
]);

/** Check if title is meaningful. */
function isValidTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const clean = title.trim().toLowerCase();
  if (clean.length < 2 || clean.length > 200) return false;
  if (REJECTED_TITLES.has(clean)) return false;
  if (/^(sign in|log in|cookie|error 404|privacy policy|terms)/i.test(clean)) return false;
  return true;
}

/** Does this object look like a job posting? */
export function looksLikeJob(o: Item): boolean {
  if (!o || typeof o !== "object") return false;

  const type = String(o["@type"] ?? "");
  if (type === "JobPosting" || type.endsWith(":JobPosting") || (Array.isArray(o["@type"]) && o["@type"].includes("JobPosting"))) {
    return true;
  }

  const title = str(o, ...TITLE_KEYS);
  if (!isValidTitle(title)) return false;

  const signals = [
    "company", "companyName", "company_name", "hiringOrganization", "employer", "employerName", "employerNameFromSearch", "startup",
    "salary", "baseSalary", "estimatedSalary", "salarySnippet", "salaryText", "compensation", "jobType",
    "employmentType", "location", "formattedLocation", "jobLocation", "locationName", "candidate_required_location",
    "datePosted", "pubDate", "postedAt", "publication_date", "createdAt", "liveStartAt", "jobkey", "jobKey",
    "ciphertext", "OrgName", "description", "jobDescription", "snippet", "summary", "applyUrl", "hostedUrl",
    "detailsPageUrl", "jobUrl", "url", "link", "isRemote", "remote", "jobLocationType", "workplaceType", "timeType", "workplace_type",
  ];

  return signals.filter((k) => k in o && o[k] != null && o[k] !== "").length >= 2;
}

/** Recursively search for job-like objects in any structure. */
export function findJobObjects(root: unknown, max = 5000): Item[] {
  const found: Item[] = [];
  const seen = new Set<unknown>();

  const walk = (v: unknown, depth: number) => {
    if (found.length >= max || depth > 25 || v == null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);

    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }

    const o = v as Item;
    if (looksLikeJob(o)) {
      found.push(o);
    } else {
      for (const k of Object.keys(o)) {
        walk(o[k], depth + 1);
      }
    }
  };

  walk(root, 0);
  return found;
}

/** Extract location string from schema.org or custom job location objects. */
export function extractLocation(o: Item): string | null {
  // Schema.org PostalAddress
  const addrLoc = str(o, "jobLocation.address.addressLocality", "jobLocation.0.address.addressLocality");
  const addrRegion = str(o, "jobLocation.address.addressRegion", "jobLocation.0.address.addressRegion");
  const addrCountry = str(o, "jobLocation.address.addressCountry", "jobLocation.0.address.addressCountry");
  if (addrLoc || addrRegion) {
    return [addrLoc, addrRegion, addrCountry].filter(Boolean).join(", ");
  }

  // Schema.org Place name
  const placeName = str(o, "jobLocation.name", "jobLocation.0.name");
  if (placeName) return placeName;

  // Applicant location requirements
  const reqLoc = str(o, "applicantLocationRequirements.name", "applicantLocationRequirements.0.name");
  if (reqLoc) return reqLoc;

  // Standard flat string keys
  return (
    str(
      o,
      "formattedLocation", "location", "locationName", "jobLocation",
      "city", "location.name", "locationsText", "candidate_required_location",
      "categories.location", "workLocation", "secondaryLocations.0.location",
    ) || null
  );
}

/** Extract salary from schema.org MonetaryAmount / PriceSpecification or text strings. */
export function extractSalary(o: Item) {
  const baseSalary = first(o, "baseSalary.value", "estimatedSalary.0.value", "baseSalary", "estimatedSalary");
  if (baseSalary && typeof baseSalary === "object") {
    const min = num(baseSalary, "minValue", "value", "min");
    const max = num(baseSalary, "maxValue", "value", "max");
    const period = str(baseSalary, "unitText", "period", "interval") ?? str(o, "baseSalary.unitText", "estimatedSalary.unitText");
    const currency = str(baseSalary, "currency") ?? str(o, "baseSalary.currency", "estimatedSalary.currency");
    if (min != null || max != null) {
      return buildSalary({ min, max, period, currency });
    }
  }

  const srMin = num(o, "salaryRange.min");
  const srMax = num(o, "salaryRange.max");
  if (srMin != null || srMax != null) {
    return buildSalary({
      min: srMin,
      max: srMax,
      currency: str(o, "salaryRange.currency"),
      period: str(o, "salaryRange.interval"),
    });
  }

  return buildSalary(
    str(
      o,
      "salarySnippet.text", "salary", "salaryText", "compensation",
      "FormattedSalaryShort", "salaryInfo", "compensationSummary",
      "compensation.compensationTierSummary", "compensation.scrapeableCompensationSalarySummary",
    ),
  );
}

/** Extract employment type from schema.org or custom keys. */
export function extractEmploymentType(o: Item) {
  const typeVal = first(o, "employmentType", "jobType", "jobTypes", "commitment", "employment_type", "typeOfEmployment.label", "timeType");
  if (Array.isArray(typeVal)) {
    return detectEmploymentType(typeVal.map(String).join(" "));
  }
  return detectEmploymentType(str(o, "employmentType", "jobType", "jobTypes", "commitment", "employment_type", "typeOfEmployment.label", "timeType"));
}

/** Extract work mode from schema.org or custom keys. */
export function extractWorkMode(o: Item, loc: string | null, title: string) {
  const locType = str(o, "jobLocationType");
  const isTelecommute = locType === "TELECOMMUTE";
  const workplace = str(o, "workplaceType", "workplace_type", "remoteLocation", "workFromHomeAvailability");
  const isRemoteBool = first(o, "remote", "isRemote", "location.remote") === true;

  return detectWorkMode(
    isTelecommute ? "remote" : null,
    workplace,
    isRemoteBool ? "remote" : null,
    loc,
    title,
    str(o, "description", "snippet"),
  );
}

/** Map a schema.org JobPosting or any job-shaped object to RawJob. */
export function genericJob(o: Item, baseUrl: string): RawJob | null {
  const title = str(o, ...TITLE_KEYS);
  if (!isValidTitle(title)) return null;

  const location = extractLocation(o);
  const salary = extractSalary(o);
  const desc = str(o, "description", "descriptionHtml", "descriptionPlain", "jobDescription", "job_description", "snippet", "summary", "content");
  const rawUrl = str(o, ...URL_KEYS);
  const rawApplyUrl = str(o, "applyUrl", "applicationLink", "thirdPartyApplyUrl", "externalApplyLink", "directApplyUrl");

  return {
    sourceJobId: str(o, "identifier.value", "jobkey", "jobKey", "id", "jobId", "listingId", "guid", "refNumber"),
    title: title!.trim(),
    company: str(o, ...COMPANY_KEYS),
    location,
    workMode: extractWorkMode(o, location, title!),
    employmentType: extractEmploymentType(o),
    salary,
    postedAt: parseDate(first(o, "datePosted", "pubDate", "postedAt", "publication_date", "createdAt", "first_published", "updated_at", "startDate", "date", "postedDate", "releasedDate", "listedAt")),
    url: absUrl(rawUrl, baseUrl),
    applyUrl: absUrl(rawApplyUrl, baseUrl),
    description: stripHtml(desc),
    skills: strArray(o, "skills", "tags", "skillsTags", "categories", "occupationalCategory"),
    companyLogo: str(o, "hiringOrganization.logo.url", "hiringOrganization.logo", "companyLogo", "company_logo", "companyLogoUrl", "logoUrl"),
    seniority: str(o, "experienceLevel.label", "experienceRequirements", "seniority"),
    applicants: num(o, "applicants", "applicantCount", "numApplicants"),
  };
}

/** Fallback HTML / DOM extractor for pages without structured JSON blobs. */
export function extractFromHtml(html: string, baseUrl: string): RawJob[] {
  const $ = cheerio.load(html);
  const jobs: RawJob[] = [];

  // 1. Check for HTML Microdata: [itemscope][itemtype*="JobPosting"]
  $('[itemscope][itemtype*="JobPosting"]').each((_, el) => {
    const item = $(el);
    const title = item.find('[itemprop="title"]').text().trim() || item.find('h1, h2').first().text().trim();
    if (!isValidTitle(title)) return;

    const company = item.find('[itemprop="hiringOrganization"] [itemprop="name"]').text().trim()
      || item.find('[itemprop="hiringOrganization"]').text().trim()
      || item.find('[itemprop="hiringOrganization"]').attr("content")
      || null;

    const loc = item.find('[itemprop="jobLocation"] [itemprop="addressLocality"]').text().trim()
      || item.find('[itemprop="jobLocation"]').text().trim()
      || null;

    const salaryText = item.find('[itemprop="baseSalary"]').text().trim() || null;
    const desc = item.find('[itemprop="description"]').html() || item.find('[itemprop="description"]').text();
    const datePosted = item.find('[itemprop="datePosted"]').attr("content") || item.find('[itemprop="datePosted"]').text().trim() || null;
    const link = item.find('a[itemprop="url"]').attr("href") || item.find("a").first().attr("href") || null;

    jobs.push({
      title,
      company: company || null,
      location: loc || null,
      workMode: detectWorkMode(loc, title, desc),
      employmentType: detectEmploymentType(item.find('[itemprop="employmentType"]').text()),
      salary: buildSalary(salaryText),
      postedAt: parseDate(datePosted),
      url: absUrl(link, baseUrl),
      description: stripHtml(desc),
    });
  });

  if (jobs.length > 0) return jobs;

  // 2. ATS and Common Job Detail Page Selectors
  const title = $(
    'h1[data-automation-id="jobPostingHeader"], h1.app-title, .app-title, .posting-headline h2, ' +
    'h1.posting-headline, [data-qa="job-title"], .jv-job-detail-top h2, .jobsearch-JobInfoHeader-title, ' +
    '.job-detail-title, .job-title, h1',
  ).first().text().trim();

  if (isValidTitle(title)) {
    const company = $(
      '[data-automation-id="companyName"], .company-name, .employer-name, ' +
      'meta[property="og:site_name"], [data-qa="company-name"], .posting-headline .company',
    ).first().text().trim() || $('meta[property="og:site_name"]').attr("content")?.trim() || null;

    const location = $(
      '[data-automation-id="locations"], [data-automation-id="jobLocation"], .location, ' +
      '.job-location, .posting-categories .location, .jv-job-detail-meta, [data-qa="job-location"]',
    ).first().text().trim() || null;

    const salaryText = $(
      '[data-automation-id="salary"], .salary, .compensation, .job-salary, .salary-snippet',
    ).first().text().trim() || null;

    const descHtml = $(
      '[data-automation-id="jobPostingDescription"], #content, #job-description, .job-description, ' +
      '.description, .posting-description, .jv-job-detail-description, article, main',
    ).first().html();

    const applyHref = $(
      'a[data-automation-id="adventureButton"], a.apply-button, a[href*="apply"], ' +
      'a.postings-btn, a.jv-button-primary',
    ).first().attr("href") || null;

    jobs.push({
      title,
      company: company || null,
      location: location || null,
      workMode: detectWorkMode(location, title, descHtml),
      employmentType: detectEmploymentType($('.employment-type, .commitment, .job-type').text()),
      salary: buildSalary(salaryText),
      postedAt: parseDate($('time, [data-automation-id="postedOn"], .date-posted').first().text()),
      url: absUrl(applyHref || baseUrl, baseUrl),
      applyUrl: absUrl(applyHref, baseUrl),
      description: stripHtml(descHtml),
    });
  }

  return jobs;
}

/**
 * Universal job extractor.
 * Walks all embedded JSON blobs (JSON-LD, Next.js, Apollo, window state)
 * and falls back to HTML microdata / ATS DOM selectors when needed.
 */
export function extractGeneric(html: string, baseUrl: string): RawJob[] {
  if (!html || typeof html !== "string") return [];

  const jobs: RawJob[] = [];
  const seen = new Set<string>();

  const addJob = (j: RawJob | null) => {
    if (!j || !isValidTitle(j.title)) return;
    // Deduplicate on url, sourceJobId, or (company + title)
    const key = (j.url || j.sourceJobId || `${j.company ?? ""}|${j.title}`).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push(j);
  };

  // 1. Structured JSON extraction
  try {
    for (const blob of embeddedJson(html)) {
      for (const o of findJobObjects(blob)) {
        addJob(genericJob(o, baseUrl));
      }
    }
  } catch {
    // If JSON parsing encounters errors, continue to DOM fallback
  }

  // 2. DOM / Microdata fallback if no jobs found
  if (jobs.length === 0) {
    try {
      for (const domJob of extractFromHtml(html, baseUrl)) {
        addJob(domJob);
      }
    } catch {
      // Ignore DOM parsing errors
    }
  }

  return jobs;
}
