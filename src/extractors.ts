/**
 * Universal extraction. Most job sites ship their data as JSON somewhere in
 * the page (JSON-LD, __NEXT_DATA__, Apollo/Nuxt state, window.* blobs). We pull
 * every blob, walk it, and keep objects that look like job postings.
 */
import { absUrl, first, num, str, strArray, stripHtml, type Item } from "./lib/extract.ts";
import { buildSalary } from "./lib/salary.ts";
import { parseDate } from "./lib/dates.ts";
import { detectEmploymentType, detectWorkMode } from "./lib/text.ts";
import type { RawJob } from "./model.ts";

const decode = (s: string) => s.replace(/&#x2B;/gi, "+").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Balanced-brace slice starting at s[i] === "{" or "[". */
function sliceJson(s: string, i: number): string | null {
  const open = s[i], close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(i, j + 1);
  }
  return null;
}

export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld(?:\+|&#x2B;)json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const v = tryJson(m[1]!.trim()) ?? tryJson(decode(m[1]!.trim()));
    if (v) out.push(v);
  }
  return out;
}

/** All JSON blobs embedded in a page. */
export function embeddedJson(html: string): unknown[] {
  const out: unknown[] = [...jsonLdBlocks(html)];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const v = tryJson(m[1]!.trim());
    if (v) out.push(v);
  }
  // window.foo = {...};  window["foo"] = {...};  __NUXT__ / mosaic providerData
  for (const m of html.matchAll(/(?:window\.[\w$.]+|window\[["'][^"']+["']\]|[\w$.]+\["[\w-]+"\])\s*=\s*(?=[{[])/g)) {
    const blob = sliceJson(html, m.index! + m[0].length);
    const v = blob && tryJson(blob);
    if (v) out.push(v);
  }
  return out;
}

const TITLE_KEYS = ["title", "jobTitle", "jobTitleText", "displayTitle", "positionName", "position", "name", "Title"];
const COMPANY_KEYS = [
  "hiringOrganization.name", "company", "companyName", "company_name", "employer.name", "employerName",
  "employerNameFromSearch", "OrgName", "organization", "startup.name", "hiringCompany.name",
];
const URL_KEYS = ["url", "jobUrl", "job_url", "link", "absolute_url", "hostedUrl", "detailsPageUrl", "jobLink", "seoJobLink", "viewJobLink", "JobURL", "applyUrl"];

/** Does this object look like a job posting? */
function looksLikeJob(o: Item): boolean {
  if (o["@type"] === "JobPosting") return true;
  const hasTitle = TITLE_KEYS.some((k) => typeof o[k] === "string");
  const signals = ["company", "companyName", "company_name", "hiringOrganization", "employer", "salary", "jobType", "location",
    "formattedLocation", "jobLocation", "locationName", "datePosted", "pubDate", "postedAt", "jobkey", "jobKey", "ciphertext", "OrgName"];
  return hasTitle && signals.filter((k) => k in o).length >= 2;
}

export function findJobObjects(root: unknown, max = 5000): Item[] {
  const found: Item[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (found.length >= max || depth > 25 || v == null || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Item;
    if (looksLikeJob(o)) found.push(o);
    else for (const k of Object.keys(o)) walk(o[k], depth + 1);
  };
  walk(root, 0);
  return found;
}

/** Map a schema.org JobPosting or any job-shaped object to RawJob. */
export function genericJob(o: Item, baseUrl: string): RawJob | null {
  const title = str(o, ...TITLE_KEYS);
  if (!title) return null;
  const location =
    str(o, "jobLocation.address.addressLocality") && [str(o, "jobLocation.address.addressLocality"), str(o, "jobLocation.address.addressRegion")].filter(Boolean).join(", ")
    || str(o, "jobLocation.0.address.addressLocality", "formattedLocation", "location", "locationName", "jobLocation", "city", "candidate_required_location");
  const baseSalary = first(o, "baseSalary.value", "estimatedSalary.0.value");
  const salary = baseSalary
    ? buildSalary({ min: num(baseSalary, "minValue", "value"), max: num(baseSalary, "maxValue"), period: str(baseSalary, "unitText") ?? str(o, "baseSalary.unitText"), currency: str(o, "baseSalary.currency") })
    : buildSalary(str(o, "salarySnippet.text", "salary", "salaryText", "compensation", "FormattedSalaryShort", "salaryInfo"));
  const desc = str(o, "description", "descriptionHtml", "snippet", "summary", "job_description");
  const type = str(o, "employmentType", "jobType", "jobTypes", "commitment", "employment_type");
  return {
    sourceJobId: str(o, "identifier.value", "jobkey", "jobKey", "id", "jobId", "listingId"),
    title,
    company: str(o, ...COMPANY_KEYS),
    location,
    workMode: detectWorkMode(str(o, "jobLocationType"), str(o, "workplaceType", "remoteLocation"), location, first(o, "remote", "isRemote") === true),
    employmentType: detectEmploymentType(type),
    salary,
    postedAt: parseDate(first(o, "datePosted", "pubDate", "postedAt", "publication_date", "createdAt", "date", "postedDate", "listedAt")),
    url: absUrl(str(o, ...URL_KEYS), baseUrl),
    applyUrl: absUrl(str(o, "applyUrl", "applicationLink", "thirdPartyApplyUrl", "externalApplyLink"), baseUrl),
    description: stripHtml(desc),
    skills: strArray(o, "skills", "tags", "skillsTags"),
    companyLogo: str(o, "hiringOrganization.logo", "companyLogo", "company_logo", "logoUrl"),
  };
}

export function extractGeneric(html: string, baseUrl: string): RawJob[] {
  const jobs: RawJob[] = [];
  for (const blob of embeddedJson(html)) for (const o of findJobObjects(blob)) {
    const j = genericJob(o, baseUrl);
    if (j) jobs.push(j);
  }
  return jobs;
}
