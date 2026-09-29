import * as cheerio from "cheerio";
import { absUrl, first, num, str, strArray, stripHtml, type Item } from "./lib/extract.ts";
import { buildSalary } from "./lib/salary.ts";
import { parseDate } from "./lib/dates.ts";
import { detectEmploymentType, detectWorkMode, slug } from "./lib/text.ts";
import { buildIndeedUrl, indeedTypeCodes } from "./lib/urls.ts";
import { extractGeneric, genericJob } from "./extractors.ts";
import type { Input } from "./input.ts";
import type { RawJob, SearchQuery, SourceId } from "./model.ts";

export interface Req {
  url: string;
  label: string; // `${source}:${kind}`
  headers?: Record<string, string>;
  userData?: Record<string, unknown>;
  uniqueKey?: string;
}
export interface HandlerResult {
  jobs: RawJob[];
  next?: Req[];
}
export interface Ctx {
  url: string;
  body: string;
  json: unknown;
  userData: Record<string, unknown>;
  q: SearchQuery;
  input: Input;
}
export interface Source {
  id: SourceId;
  /** "http" = fast plain requests. "browser" = Playwright + residential proxy (anti-bot sites). */
  tier: "http" | "browser";
  plan(q: SearchQuery, input: Input): Req[];
  /** Turn a pasted site URL into the request(s) this source needs. */
  fromUrl?(url: string, q: SearchQuery): Req[];
  handle: Record<string, (c: Ctx) => HandlerResult>;
}

const kw = (q: SearchQuery) => q.keywords;
const enc = encodeURIComponent;
const matchesKeywords = (q: SearchQuery, ...texts: (string | null | undefined)[]) => {
  if (!q.keywords) return true;
  const hay = texts.filter(Boolean).join(" ").toLowerCase();
  return q.keywords.toLowerCase().split(/\s+/).filter((w) => w.length > 2).every((w) => hay.includes(w));
};
const pages = (q: SearchQuery, per: number) => Math.max(1, Math.ceil(q.maxResultsPerSource / per));

// ---------------------------------------------------------------- LinkedIn
// Public guest endpoints (no login). 10 cards per page, up to ~1000.
const LI_TYPES: Record<string, string> = { full_time: "F", part_time: "P", contract: "C", temporary: "T", internship: "I", freelance: "C" };
const LI_EXP: Record<string, string> = {
  intern: "1",
  entry: "2",
  mid: "3,4",
  senior: "4",
  lead: "4,5",
  staff: "5",
  principal: "5",
  director: "5",
  executive: "6",
};
const LI_WT: Record<string, string> = { onsite: "1", remote: "2", hybrid: "3" };

const linkedinListUrl = (params: URLSearchParams, start: number) => {
  params.set("start", String(start));
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`;
};
const linkedin: Source = {
  id: "linkedin",
  tier: "http",
  plan(q) {
    const p = new URLSearchParams({ keywords: kw(q), location: q.location || (q.remoteOnly ? "United States" : "") });
    if (q.radiusMiles) p.set("distance", String(q.radiusMiles));
    if (q.postedWithinDays) p.set("f_TPR", `r${q.postedWithinDays * 86400}`);

    if (q.workModes?.length) {
      const wtCodes = [...new Set(q.workModes.map((w) => LI_WT[w]).filter(Boolean))];
      if (wtCodes.length) p.set("f_WT", wtCodes.join(","));
    } else if (q.remoteOnly) {
      p.set("f_WT", "2");
    }

    if (q.seniorityLevels?.length) {
      const expCodes = [...new Set(q.seniorityLevels.map((l) => LI_EXP[l]).filter((x): x is string => Boolean(x)).flatMap((x) => x.split(",")))];
      if (expCodes.length) p.set("f_E", expCodes.join(","));
    }

    const jt = [...new Set(q.employmentTypes.map((t) => LI_TYPES[t]).filter(Boolean))];
    if (jt.length) p.set("f_JT", jt.join(","));
    if (q.minSalary) p.set("f_SB2", String(Math.min(9, Math.max(1, Math.floor(q.minSalary / 20000) - 1)))); // 1=$40k … 9=$200k
    return [{ url: linkedinListUrl(p, 0), label: "linkedin:list", userData: { params: p.toString(), start: 0 } }];
  },
  fromUrl(url) {
    try {
      const p = new URL(url).searchParams;
      for (const k of ["currentJobId", "trk", "refId", "trackingId", "position", "pageNum", "origin"]) p.delete(k);
      return [{ url: linkedinListUrl(p, 0), label: "linkedin:list", userData: { params: p.toString(), start: 0 } }];
    } catch {
      return [{ url, label: "linkedin:list", userData: { params: "", start: 0 } }];
    }
  },
  handle: {
    "linkedin:list"({ body, userData, q, input, url }) {
      try {
        const $ = cheerio.load(body);
        const jobs: RawJob[] = [];
        const next: Req[] = [];
        $("li").each((_, li) => {
          const el = $(li);
          const id = el.find("[data-entity-urn]").attr("data-entity-urn")?.split(":").pop() ?? null;
          const title = el.find(".base-search-card__title").text().trim();
          if (!title) return;
          const jobUrl = el.find("a.base-card__full-link").attr("href")?.split("?")[0] ?? null;
          const job: RawJob = {
            sourceJobId: id,
            title,
            company: el.find(".base-search-card__subtitle").text().trim() || null,
            location: el.find(".job-search-card__location").text().trim() || null,
            postedAt: parseDate(el.find("time").attr("datetime")) ?? parseDate(el.find("time").text()),
            salary: buildSalary(el.find(".job-search-card__salary-info").text().trim() || null),
            url: jobUrl,
            companyUrl: el.find(".base-search-card__subtitle a").attr("href")?.split("?")[0] ?? null,
          };
          job.workMode = detectWorkMode(job.location, job.title);
          if (input.fetchDetails && id) {
            next.push({ url: `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, label: "linkedin:detail", userData: { job } });
          } else jobs.push(job);
        });
        const start = Number(userData.start) + 10;
        const found = next.length + jobs.length;
        if (found >= 10 && start < q.maxResultsPerSource) {
          next.push({ url: linkedinListUrl(new URLSearchParams(String(userData.params)), start), label: "linkedin:list", userData: { params: userData.params, start } });
        }
        return { jobs: jobs.length ? jobs : extractGeneric(body, url), next };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
    "linkedin:detail"({ body, userData, url }) {
      try {
        const $ = cheerio.load(body);
        const job = { ...(userData.job as RawJob) };
        const criteria: Record<string, string> = {};
        $(".description__job-criteria-item").each((_, el) => {
          criteria[$(el).find("h3").text().trim()] = $(el).find("span").text().trim();
        });
        job.description = stripHtml($(".show-more-less-html__markup").html() ?? null);
        job.seniority = criteria["Seniority level"] ?? null;
        job.employmentType = detectEmploymentType(criteria["Employment type"]);
        job.applicants = num($(".num-applicants__caption").text()) ?? null;
        const comp = $(".compensation__salary").text().trim();
        if (comp) job.salary = buildSalary(comp);
        else if (!job.salary?.annualMin && job.description) {
          const m = job.description.match(/\$\s?\d{2,3}[,.]?\d{3}(?:\.\d{2})?\s*(?:-|–|to)\s*\$\s?\d{2,3}[,.]?\d{3}(?:\.\d{2})?/);
          if (m) job.salary = buildSalary(`${m[0]} per year`);
        }
        const offsite = $("code#applyUrl").html()?.match(/url=([^"&]+)/)?.[1];
        if (offsite) job.applyUrl = decodeURIComponent(offsite);
        job.workMode = detectWorkMode(job.location, job.title, job.description?.slice(0, 600));
        job.extra = { industries: criteria["Industries"], jobFunction: criteria["Job function"] };
        return { jobs: [job] };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

// ---------------------------------------------------------------- Dice
// Dice's own frontend search API. 100 per page.
const DICE_DAYS: Record<number, string> = { 1: "ONE", 3: "THREE", 7: "SEVEN", 14: "THIRTY", 30: "THIRTY" };
const DICE_TYPES: Record<string, string> = { full_time: "FULLTIME", part_time: "PARTTIME", contract: "CONTRACTS", freelance: "CONTRACTS", temporary: "CONTRACTS" };
const DICE_EXP: Record<string, string> = {
  intern: "Entry",
  entry: "Entry",
  mid: "Mid",
  senior: "Senior",
  lead: "Senior",
  staff: "Senior",
  principal: "Senior",
  director: "Senior",
  executive: "Senior",
};
const DICE_WM: Record<string, string> = { remote: "Remote", hybrid: "Hybrid", onsite: "On-Site" };

const dice: Source = {
  id: "dice",
  tier: "http",
  plan(q, input) {
    const p = new URLSearchParams({ q: kw(q), countryCode2: q.country, page: "1", pageSize: "100", language: "en", sort: "date" });
    if (q.location) p.set("location", q.location);
    if (q.radiusMiles) { p.set("radius", String(q.radiusMiles)); p.set("radiusUnit", "mi"); }
    if (q.postedWithinDays) p.set("filters.postedDate", DICE_DAYS[q.postedWithinDays]!);

    if (q.workModes?.length) {
      const wm = [...new Set(q.workModes.map((w) => DICE_WM[w]).filter(Boolean))];
      if (wm.length) p.set("filters.workplaceTypes", wm.join("|"));
    } else if (q.remoteOnly) {
      p.set("filters.workplaceTypes", "Remote");
    }

    if (q.seniorityLevels?.length) {
      const exp = [...new Set(q.seniorityLevels.map((l) => DICE_EXP[l]).filter(Boolean))];
      if (exp.length) p.set("filters.experienceLevel", exp.join("|"));
    }

    if (q.minSalary) {
      p.set("filters.salaryMin", String(q.minSalary));
    }

    const t = [...new Set(q.employmentTypes.map((x) => DICE_TYPES[x]).filter(Boolean))];
    if (t.length) p.set("filters.employmentType", t.join("|"));
    return [{ url: `https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search?${p}`, label: "dice:list", headers: { "x-api-key": input.diceApiKey, origin: "https://www.dice.com" } }];
  },
  handle: {
    "dice:list"({ json, url, q, input, body }) {
      try {
        const d = (json ?? (body ? JSON.parse(body) : {})) as { data?: Item[]; meta?: { pageCount?: number; currentPage?: number } };
        const jobs = (d.data ?? []).map<RawJob>((o) => ({
          sourceJobId: str(o, "guid", "id"),
          title: str(o, "title")!,
          company: str(o, "companyName"),
          location: str(o, "jobLocation.displayName"),
          workMode: detectWorkMode(str(o, "workplaceTypes"), o.isRemote === true, str(o, "workFromHomeAvailability") === "TRUE"),
          employmentType: detectEmploymentType(str(o, "employmentType")),
          salary: buildSalary(str(o, "salary")),
          postedAt: parseDate(str(o, "postedDate")),
          url: str(o, "detailsPageUrl"),
          description: str(o, "summary"),
          companyUrl: str(o, "companyPageUrl"),
          companyLogo: str(o, "companyLogoUrl"),
          extra: { easyApply: o.easyApply, employerType: o.employerType, willingToSponsor: o.willingToSponsor },
        })).filter((j) => j.title);

        const page = d.meta?.currentPage ?? 1;
        const next: Req[] = [];
        if (page < (d.meta?.pageCount ?? 1) && page < pages(q, 100)) {
          const u = new URL(url);
          u.searchParams.set("page", String(page + 1));
          next.push({ url: u.toString(), label: "dice:list", headers: { "x-api-key": input.diceApiKey, origin: "https://www.dice.com" } });
        }
        return { jobs, next };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

// ---------------------------------------------------------------- Wellfound
// Server-rendered Apollo cache in __NEXT_DATA__.
const wellfound: Source = {
  id: "wellfound",
  tier: "http",
  plan(q) {
    const role = slug(q.keywords || "software engineer");
    const base = q.remoteOnly || !q.location ? `https://wellfound.com/role/r/${role}` : `https://wellfound.com/role/l/${role}/${slug(q.location.split(",")[0]!)}`;
    return Array.from({ length: Math.min(10, pages(q, 20)) }, (_, i) => ({ url: i ? `${base}?page=${i + 1}` : base, label: "wellfound:list" }));
  },
  fromUrl: (url) => [{ url, label: "wellfound:list" }],
  handle: {
    "wellfound:list"({ body, url }) {
      try {
        const m = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (!m) return { jobs: extractGeneric(body, url) };
        const ap = (JSON.parse(m[1]!)?.props?.pageProps?.apolloState?.data ?? {}) as Record<string, Item>;
        const companyOf = new Map<string, Item>();
        for (const v of Object.values(ap)) {
          if (v.__typename !== "StartupResult") continue;
          for (const ref of (v.highlightedJobListings as { __ref: string }[] | undefined) ?? []) companyOf.set(ref.__ref, v);
        }
        const jobs: RawJob[] = [];
        for (const [key, o] of Object.entries(ap)) {
          if (o.__typename !== "JobListingSearchResult") continue;
          const co = companyOf.get(key);
          jobs.push({
            sourceJobId: str(o, "id"),
            title: str(o, "title")!,
            company: co ? str(co, "name") : null,
            location: strArray(o, "locationNames").join(" / ") || null,
            workMode: o.remote ? (str(o, "remoteConfig.kind") === "HYBRID" ? "hybrid" : "remote") : "onsite",
            employmentType: detectEmploymentType(str(o, "jobType")),
            salary: buildSalary(`${(str(o, "compensation") ?? "").split("•")[0]} per year`.trim() === "per year" ? null : `${(str(o, "compensation") ?? "").split("•")[0]!.trim()} per year`),
            postedAt: parseDate(o.liveStartAt),
            url: `https://wellfound.com/jobs/${str(o, "id")}-${str(o, "slug")}`,
            description: str(o, "description"),
            companyUrl: co ? `https://wellfound.com/company/${str(co, "slug")}` : null,
            companyLogo: co ? str(co, "logoUrl") : null,
            extra: { equity: (str(o, "compensation") ?? "").split("•")[1]?.trim(), companySize: co?.companySize, pitch: co?.highConcept, yearsExperienceMin: o.yearsExperienceMin },
          });
        }
        return { jobs: jobs.length ? jobs : extractGeneric(body, url) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

// ---------------------------------------------------------------- BuiltIn
const builtin: Source = {
  id: "builtin",
  tier: "http",
  plan(q) {
    const path = q.remoteOnly ? "https://builtin.com/jobs/remote" : "https://builtin.com/jobs";
    return Array.from({ length: Math.min(20, pages(q, 25)) }, (_, i) => ({ url: `${path}?search=${enc(kw(q))}${i ? `&page=${i + 1}` : ""}`, label: "builtin:list" }));
  },
  fromUrl: (url) => [{ url, label: "builtin:list" }],
  handle: {
    "builtin:list"({ body, input, url }) {
      try {
        const $ = cheerio.load(body);
        const jobs: RawJob[] = [];
        const next: Req[] = [];
        $('[data-id="job-card"]').each((_, c) => {
          const el = $(c);
          const a = el.find('[data-id="job-card-title"]');
          const jobUrl = absUrl(a.attr("href") ?? null, "https://builtin.com");
          const texts = el.find(".bounded-attribute-section span").map((_, s) => $(s).text().trim()).get().filter(Boolean);
          const job: RawJob = {
            sourceJobId: jobUrl?.split("/").pop() ?? null,
            title: a.text().trim(),
            company: el.find('[data-id="company-title"]').text().trim() || null,
            postedAt: parseDate(texts.find((t) => /ago|today|yesterday/i.test(t))),
            location: texts.find((t) => /,|remote|hybrid/i.test(t) && !/ago/i.test(t)) ?? null,
            salary: buildSalary(texts.find((t) => /\$|K\b/.test(t) && /\d/.test(t)) ?? null),
            url: jobUrl,
          };
          job.workMode = detectWorkMode(texts.join(" "));
          if (input.fetchDetails && jobUrl) next.push({ url: jobUrl, label: "builtin:detail", userData: { job } });
          else if (job.title) jobs.push(job);
        });
        return { jobs: jobs.length ? jobs : extractGeneric(body, url), next };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
    "builtin:detail"({ body, url, userData }) {
      const base = (userData.job ?? {}) as RawJob;
      const ld = extractGeneric(body, url)[0];
      return { jobs: [{ ...base, ...Object.fromEntries(Object.entries(ld ?? {}).filter(([, v]) => v != null && v !== "")), title: base.title || ld?.title || "Job Posting", url: base.url || url } as RawJob] };
    },
  },
};

// ---------------------------------------------------------------- Remote boards (public APIs / feeds)
const remoteok: Source = {
  id: "remoteok",
  tier: "http",
  plan: (q) => [{ url: `https://remoteok.com/api${q.keywords ? `?tag=${enc(slug(q.keywords.split(/\s+/).pop()!))}` : ""}`, label: "remoteok:api" }],
  handle: {
    "remoteok:api"({ json, body, q, url }) {
      try {
        const arr = (((json ?? (body ? JSON.parse(body) : [])) as Item[]) ?? []).filter((o) => o.position);
        return {
          jobs: arr.filter((o) => matchesKeywords(q, str(o, "position"), strArray(o, "tags").join(" "))).map((o) => ({
            sourceJobId: str(o, "id"),
            title: str(o, "position")!,
            company: str(o, "company"),
            location: str(o, "location") ?? "Remote",
            workMode: "remote",
            salary: num(o, "salary_min") ? buildSalary({ min: num(o, "salary_min"), max: num(o, "salary_max"), period: "year", currency: "USD" }) : null,
            postedAt: parseDate(o.epoch),
            url: str(o, "url"),
            applyUrl: str(o, "apply_url"),
            description: stripHtml(str(o, "description")),
            skills: strArray(o, "tags"),
            companyLogo: str(o, "company_logo"),
          })),
        };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const remotive: Source = {
  id: "remotive",
  tier: "http",
  plan: (q) => [{ url: `https://remotive.com/api/remote-jobs?search=${enc(kw(q))}&limit=${q.maxResultsPerSource}`, label: "remotive:api" }],
  handle: {
    "remotive:api"({ json, body, url }) {
      try {
        const parsed = (json ?? (body ? JSON.parse(body) : {})) as { jobs?: Item[] };
        return {
          jobs: (parsed.jobs ?? []).map((o) => ({
            sourceJobId: str(o, "id"),
            title: str(o, "title")!,
            company: str(o, "company_name"),
            location: str(o, "candidate_required_location"),
            workMode: "remote",
            employmentType: detectEmploymentType(str(o, "job_type")),
            salary: buildSalary(str(o, "salary")),
            postedAt: parseDate(str(o, "publication_date")),
            url: str(o, "url"),
            description: stripHtml(str(o, "description")),
            skills: strArray(o, "tags"),
            companyLogo: str(o, "company_logo"),
          })),
        };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const himalayas: Source = {
  id: "himalayas",
  tier: "http",
  plan: (q) => [{ url: `https://himalayas.app/jobs/api/search?q=${enc(kw(q))}&page=1`, label: "himalayas:api", userData: { page: 1 } }],
  handle: {
    "himalayas:api"({ json, body, q, userData, url }) {
      try {
        const d = (json ?? (body ? JSON.parse(body) : {})) as { jobs?: Item[] };
        const jobs = (d.jobs ?? []).map<RawJob>((o) => ({
          sourceJobId: str(o, "guid"),
          title: str(o, "title")!,
          company: str(o, "companyName"),
          location: strArray(o, "locationRestrictions").join(", ") || "Remote (anywhere)",
          workMode: "remote",
          employmentType: detectEmploymentType(str(o, "employmentType")),
          salary: num(o, "minSalary") ? buildSalary({ min: num(o, "minSalary"), max: num(o, "maxSalary"), currency: str(o, "currency"), period: str(o, "salaryPeriod") }) : null,
          postedAt: parseDate(num(o, "pubDate")),
          url: str(o, "applicationLink", "guid"),
          description: stripHtml(str(o, "description", "excerpt")),
          skills: strArray(o, "categories"),
          seniority: strArray(o, "seniority").join(", ") || null,
          companyLogo: str(o, "companyLogo"),
        }));
        const page = Number(userData.page || 1);
        const next = jobs.length && page < pages(q, 20) ? [{ url: `https://himalayas.app/jobs/api/search?q=${enc(kw(q))}&page=${page + 1}`, label: "himalayas:api", userData: { page: page + 1 } }] : [];
        return { jobs, next };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const weworkremotely: Source = {
  id: "weworkremotely",
  tier: "http",
  plan: () => [{ url: "https://weworkremotely.com/remote-jobs.rss", label: "wwr:rss" }],
  handle: {
    "wwr:rss"({ body, q, url }) {
      try {
        const $ = cheerio.load(body, { xml: true });
        const jobs: RawJob[] = [];
        $("item").each((_, it) => {
          const el = $(it);
          const raw = el.find("title").text(); // "Company: Role"
          const [company, ...rest] = raw.split(":");
          const title = rest.join(":").trim() || raw;
          const description = stripHtml(el.find("description").text());
          if (!matchesKeywords(q, title, el.find("category").text())) return;
          jobs.push({
            title,
            company: company?.trim() ?? null,
            workMode: "remote",
            location: el.find("region").text() || "Remote",
            postedAt: parseDate(el.find("pubDate").text()),
            url: el.find("link").text() || el.find("guid").text(),
            employmentType: detectEmploymentType(el.find("type").text()),
            description,
            skills: el.find("skills").text().split(",").map((s) => s.trim()).filter(Boolean),
          });
        });
        return { jobs: jobs.slice(0, q.maxResultsPerSource) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

// Hacker News "Ask HN: Who is hiring?" — the latest monthly thread, parsed.
const hackernews: Source = {
  id: "hackernews",
  tier: "http",
  plan: () => [{ url: "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5", label: "hn:thread" }],
  handle: {
    "hn:thread"({ json, body }) {
      try {
        const parsed = (json ?? (body ? JSON.parse(body) : {})) as { hits?: Item[] };
        const hit = (parsed.hits ?? []).find((h) => /who is hiring/i.test(String(h.title)));
        return { jobs: [], next: hit ? [{ url: `https://hn.algolia.com/api/v1/items/${hit.objectID}`, label: "hn:items" }] : [] };
      } catch {
        return { jobs: [] };
      }
    },
    "hn:items"({ json, body, q }) {
      try {
        const parsed = (json ?? (body ? JSON.parse(body) : {})) as { children?: Item[] };
        const kids = (parsed.children ?? []).filter((c) => c.text);
        const jobs: RawJob[] = [];
        for (const c of kids) {
          const text = stripHtml(String(c.text)) ?? "";
          const head = text.split("\n")[0] ?? "";
          const parts = head.split("|").map((s) => s.trim());
          if (parts.length < 2 || !matchesKeywords(q, text)) continue;
          jobs.push({
            sourceJobId: str(c, "id"),
            company: parts[0] ?? null,
            title: parts.find((p, i) => i > 0 && /engineer|developer|designer|manager|scientist|lead|architect|analyst|devops|sre|founding/i.test(p)) ?? parts[1]!,
            location: parts.find((p) => /remote|onsite|hybrid|,|sf|nyc|london/i.test(p)) ?? null,
            workMode: detectWorkMode(head),
            salary: buildSalary(parts.find((p) => /\$|€|£|\dk/i.test(p)) ?? null),
            postedAt: parseDate(c.created_at_i),
            url: `https://news.ycombinator.com/item?id=${c.id}`,
            description: text,
          });
        }
        return { jobs: jobs.slice(0, q.maxResultsPerSource) };
      } catch {
        return { jobs: [] };
      }
    },
  },
};

// ---------------------------------------------------------------- Company ATS Boards
export type ATSKind = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "workday" | "jobvite" | "workable" | "breezy" | "recruitee";

export interface ParsedBoard {
  ats: ATSKind;
  slug: string;
  subpath?: string;
  domain?: string;
}

export function parseBoard(s: string): ParsedBoard | null {
  const trimmed = s.trim();
  if (!trimmed) return null;

  // 1. Shorthand prefixes: e.g. "greenhouse:stripe", "gh:stripe", "sr:uber", "workday:nvidia/external", "wd:nvidia/external"
  const prefixMatch = trimmed.match(/^(greenhouse|gh|lever|lv|ashby|ab|smartrecruiters|sr|workday|wd|jobvite|jv|workable|breezy|recruitee):([^\s]+)$/i);
  if (prefixMatch) {
    const rawKind = prefixMatch[1]!.toLowerCase();
    const rest = prefixMatch[2]!;
    const kindMap: Record<string, ATSKind> = {
      greenhouse: "greenhouse", gh: "greenhouse",
      lever: "lever", lv: "lever",
      ashby: "ashby", ab: "ashby",
      smartrecruiters: "smartrecruiters", sr: "smartrecruiters",
      workday: "workday", wd: "workday",
      jobvite: "jobvite", jv: "jobvite",
      workable: "workable",
      breezy: "breezy",
      recruitee: "recruitee",
    };
    const ats = kindMap[rawKind]!;
    if (ats === "workday") {
      const [slug, subpath] = rest.split(/[/:_]/);
      return { ats, slug: slug!, subpath: subpath || "careers" };
    }
    return { ats, slug: rest };
  }

  // 2. Greenhouse URLs
  const ghEmbed = trimmed.match(/greenhouse\.io\/embed\/job_board\?for=([\w.-]+)/i);
  if (ghEmbed) return { ats: "greenhouse", slug: ghEmbed[1]! };
  const gh = trimmed.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([\w.-]+)/i)
    || trimmed.match(/greenhouse\.io\/([\w.-]+)/i);
  if (gh) return { ats: "greenhouse", slug: gh[1]! };

  // 3. Lever URLs
  const lv = trimmed.match(/jobs\.lever\.co\/([\w.-]+)/i) || trimmed.match(/lever\.co\/([\w.-]+)/i);
  if (lv) return { ats: "lever", slug: lv[1]! };

  // 4. Ashby URLs
  const ab = trimmed.match(/jobs\.ashbyhq\.com\/([\w.-]+)/i) || trimmed.match(/ashbyhq\.com\/([\w.-]+)/i);
  if (ab) return { ats: "ashby", slug: ab[1]! };

  // 5. SmartRecruiters URLs
  const sr = trimmed.match(/(?:jobs|careers)\.smartrecruiters\.com\/([\w.-]+)/i) || trimmed.match(/smartrecruiters\.com\/([\w.-]+)/i);
  if (sr) return { ats: "smartrecruiters", slug: sr[1]! };

  // 6. Workday URLs: e.g. https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
  const wd = trimmed.match(/https?:\/\/([\w.-]+)\.(wd\d+|myworkdayjobs)\.myworkdayjobs\.com\/(?:[a-zA-Z-]+\/)?([\w.-]+)/i)
    || trimmed.match(/https?:\/\/([\w.-]+)\.myworkdayjobs\.com\/(?:[a-zA-Z-]+\/)?([\w.-]+)/i);
  if (wd) {
    const slug = wd[1]!;
    const domain = wd[2]?.startsWith("wd") ? `${slug}.${wd[2]}.myworkdayjobs.com` : `${slug}.myworkdayjobs.com`;
    const subpath = wd[3] || "External";
    return { ats: "workday", slug, subpath, domain };
  }

  // 7. Jobvite URLs
  const jv = trimmed.match(/jobs\.jobvite\.com\/([\w.-]+)/i) || trimmed.match(/jobvite\.com\/([\w.-]+)/i);
  if (jv) return { ats: "jobvite", slug: jv[1]! };

  // 8. Workable URLs
  const wk = trimmed.match(/apply\.workable\.com\/([\w.-]+)/i);
  if (wk) return { ats: "workable", slug: wk[1]! };

  // 9. Breezy HR URLs
  const bz = trimmed.match(/([\w.-]+)\.breezy\.hr/i);
  if (bz) return { ats: "breezy", slug: bz[1]! };

  // 10. Recruitee URLs
  const rc = trimmed.match(/([\w.-]+)\.recruitee\.com/i);
  if (rc) return { ats: "recruitee", slug: rc[1]! };

  return null;
}

const atsFilter = (q: SearchQuery, j: RawJob) =>
  matchesKeywords(q, j.title) && (!q.remoteOnly || j.workMode === "remote") &&
  (!q.location || q.remoteOnly || !j.location || j.workMode === "remote" || j.location.toLowerCase().includes(q.location.split(",")[0]!.toLowerCase()));

const greenhouse: Source = {
  id: "greenhouse",
  tier: "http",
  plan: () => [],
  handle: {
    "greenhouse:board"({ json, body, q, userData, url }) {
      try {
        const parsed = (json ?? (body ? JSON.parse(body) : {})) as { jobs?: Item[] };
        const rawJobs = parsed.jobs ?? [];
        if (!rawJobs.length) return { jobs: extractGeneric(body, url) };

        const jobs = rawJobs.map<RawJob>((o) => {
          const locName = str(o, "location.name", "offices.0.location", "offices.0.name");
          const metadata = (o.metadata as { name?: string; value?: unknown }[] | undefined) ?? [];
          const pay = o.pay_transparency as { min?: number; max?: number; currency?: string; interval?: string } | undefined;
          const salaryMeta = metadata.find((m) => /salary|compensation|pay/i.test(String(m.name)))?.value;

          return {
            sourceJobId: str(o, "id"),
            title: str(o, "title")!,
            company: String(userData.company || userData.slug || "Company"),
            location: locName,
            workMode: detectWorkMode(locName, str(o, "content")),
            employmentType: detectEmploymentType(str(metadata.find((m) => /employment|type/i.test(String(m.name)))?.value)),
            salary: pay ? buildSalary({ min: pay.min, max: pay.max, currency: pay.currency, period: pay.interval }) : buildSalary(String(salaryMeta ?? "")),
            postedAt: parseDate(str(o, "first_published", "updated_at")),
            url: str(o, "absolute_url"),
            description: stripHtml(stripHtml(str(o, "content"))),
            skills: strArray(o, "departments"),
          };
        });
        return { jobs: jobs.filter((j) => atsFilter(q, j)) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const lever: Source = {
  id: "lever",
  tier: "http",
  plan: () => [],
  handle: {
    "lever:board"({ json, body, q, userData, url }) {
      try {
        const parsed = (json ?? (body ? JSON.parse(body) : [])) as Item[];
        if (!Array.isArray(parsed) || !parsed.length) return { jobs: extractGeneric(body, url) };

        const jobs = parsed.map<RawJob>((o) => ({
          sourceJobId: str(o, "id"),
          title: str(o, "text")!,
          company: String(userData.company || userData.slug || "Company"),
          location: str(o, "categories.location"),
          workMode: detectWorkMode(str(o, "workplaceType"), str(o, "categories.location")),
          employmentType: detectEmploymentType(str(o, "categories.commitment")),
          salary: num(o, "salaryRange.min") ? buildSalary({ min: num(o, "salaryRange.min"), max: num(o, "salaryRange.max"), currency: str(o, "salaryRange.currency"), period: str(o, "salaryRange.interval")?.replace("per-", "") }) : null,
          postedAt: parseDate(o.createdAt),
          url: str(o, "hostedUrl"),
          applyUrl: str(o, "applyUrl"),
          description: str(o, "descriptionPlain", "description"),
          skills: strArray(o, "categories.team", "categories.department"),
        }));
        return { jobs: jobs.filter((j) => atsFilter(q, j)) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const ashby: Source = {
  id: "ashby",
  tier: "http",
  plan: () => [],
  handle: {
    "ashby:board"({ json, body, q, userData, url }) {
      try {
        const parsed = (json ?? (body ? JSON.parse(body) : {})) as { jobs?: Item[] };
        const rawJobs = parsed.jobs ?? [];
        if (!rawJobs.length) return { jobs: extractGeneric(body, url) };

        const jobs = rawJobs.filter((o) => o.isListed !== false).map<RawJob>((o) => ({
          sourceJobId: str(o, "id"),
          title: str(o, "title")!,
          company: String(userData.company || userData.slug || "Company"),
          location: str(o, "location", "secondaryLocations.0.location"),
          workMode: o.isRemote ? "remote" : detectWorkMode(str(o, "workplaceType"), str(o, "location")),
          employmentType: detectEmploymentType(str(o, "employmentType")?.replace(/([a-z])([A-Z])/g, "$1 $2")),
          salary: buildSalary(str(o, "compensation.compensationTierSummary", "compensation.scrapeableCompensationSalarySummary")),
          postedAt: parseDate(str(o, "publishedAt")),
          url: str(o, "jobUrl"),
          applyUrl: str(o, "applyUrl"),
          description: str(o, "descriptionPlain", "descriptionHtml"),
          skills: strArray(o, "department"),
        }));
        return { jobs: jobs.filter((j) => atsFilter(q, j)) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const smartrecruiters: Source = {
  id: "smartrecruiters",
  tier: "http",
  plan: () => [],
  handle: {
    "smartrecruiters:board"({ json, body, q, userData, url, input }) {
      try {
        const parsed = (json ?? (body ? JSON.parse(body) : {})) as { content?: Item[] };
        const rawJobs = parsed.content ?? [];
        if (!rawJobs.length) return { jobs: extractGeneric(body, url) };

        const company = String(userData.company || userData.slug || "Company");
        const next: Req[] = [];
        const jobs: RawJob[] = [];

        for (const o of rawJobs) {
          const id = str(o, "id");
          const name = str(o, "name");
          if (!name) continue;

          const locCity = str(o, "location.city");
          const locRegion = str(o, "location.region");
          const locCountry = str(o, "location.country");
          const location = [locCity, locRegion, locCountry].filter(Boolean).join(", ") || null;
          const isRemote = first(o, "location.remote") === true;

          const job: RawJob = {
            sourceJobId: id,
            title: name,
            company: str(o, "company.name") || company,
            location,
            workMode: isRemote ? "remote" : detectWorkMode(location, name),
            employmentType: detectEmploymentType(str(o, "typeOfEmployment.label", "typeOfEmployment.id")),
            postedAt: parseDate(str(o, "releasedDate")),
            url: `https://jobs.smartrecruiters.com/${userData.slug}/${id}`,
            seniority: str(o, "experienceLevel.label"),
            skills: strArray(o, "department.label", "function.label"),
          };

          if (input.fetchDetails && id) {
            next.push({
              url: `https://api.smartrecruiters.com/v1/companies/${userData.slug}/postings/${id}`,
              label: "smartrecruiters:detail",
              userData: { job, company, slug: userData.slug },
            });
          } else {
            jobs.push(job);
          }
        }

        return { jobs: jobs.filter((j) => atsFilter(q, j)), next };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
    "smartrecruiters:detail"({ json, body, userData, url }) {
      try {
        const parsed = (json ?? (body ? JSON.parse(body) : {})) as Item;
        const base = (userData.job ?? {}) as RawJob;
        const jobDesc = str(parsed, "jobAd.sections.jobDescription.text", "jobAd.sections.qualifications.text");
        const comp = parsed.compensation as { min?: number; max?: number; currency?: string } | undefined;

        const updated: RawJob = {
          ...base,
          description: stripHtml(jobDesc) || base.description,
          salary: comp?.min ? buildSalary({ min: comp.min, max: comp.max, currency: comp.currency }) : base.salary,
        };
        return { jobs: [updated] };
      } catch {
        return { jobs: userData.job ? [userData.job as RawJob] : extractGeneric(body, url) };
      }
    },
  },
};

const workday: Source = {
  id: "workday",
  tier: "browser",
  plan: () => [],
  handle: {
    "workday:board"({ json, body, url, userData, q }) {
      try {
        const parsed = (json ?? (body ? tryJson(body) : null)) as { jobPostings?: Item[] } | null;
        if (parsed?.jobPostings?.length) {
          const domain = String(userData.domain || new URL(url).host);
          const jobs = parsed.jobPostings.map<RawJob>((o) => {
            const path = str(o, "externalPath") || "";
            const fullUrl = path.startsWith("http") ? path : `https://${domain}${path}`;
            const bullets = strArray(o, "bulletFields");
            return {
              sourceJobId: str(o, "bulletFields.0", "id"),
              title: str(o, "title")!,
              company: String(userData.company || userData.slug || "Company"),
              location: str(o, "locationsText"),
              workMode: detectWorkMode(str(o, "locationsText"), str(o, "title")),
              employmentType: detectEmploymentType(bullets.join(" ")),
              postedAt: parseDate(str(o, "postedOn")),
              url: fullUrl,
            };
          });
          return { jobs: jobs.filter((j) => atsFilter(q, j)) };
        }
        return { jobs: extractGeneric(body, url).filter((j) => atsFilter(q, j)) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

function tryJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

const jobvite: Source = {
  id: "jobvite",
  tier: "http",
  plan: () => [],
  handle: {
    "jobvite:board"({ body, q, userData, url }) {
      try {
        // If XML feed
        if (body.includes("<result>") || body.includes("<job>")) {
          const $ = cheerio.load(body, { xml: true });
          const jobs: RawJob[] = [];
          $("job").each((_, el) => {
            const item = $(el);
            const title = item.find("title").text().trim();
            if (!title) return;
            const loc = item.find("location").text().trim() || null;
            const jobUrl = item.find("detail-url").text().trim() || item.find("apply-url").text().trim() || null;
            jobs.push({
              sourceJobId: item.find("id").text().trim() || null,
              title,
              company: String(userData.company || userData.slug || "Company"),
              location: loc,
              workMode: detectWorkMode(loc, title),
              employmentType: detectEmploymentType(item.find("job-type").text()),
              postedAt: parseDate(item.find("date").text()),
              url: jobUrl,
              applyUrl: item.find("apply-url").text().trim() || null,
              description: stripHtml(item.find("description").text()),
              skills: strArray(item.find("category").text()),
            });
          });
          return { jobs: jobs.filter((j) => atsFilter(q, j)) };
        }
        return { jobs: extractGeneric(body, url).filter((j) => atsFilter(q, j)) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const workable: Source = {
  id: "workable",
  tier: "http",
  plan: () => [],
  handle: {
    "workable:board"({ json, body, q, userData, url }) {
      try {
        const parsed = (json ?? (body ? tryJson(body) : null)) as { results?: Item[]; jobs?: Item[] } | null;
        const rawJobs = parsed?.results ?? parsed?.jobs ?? [];
        if (!rawJobs.length) return { jobs: extractGeneric(body, url).filter((j) => atsFilter(q, j)) };

        const jobs = rawJobs.map<RawJob>((o) => ({
          sourceJobId: str(o, "shortcode", "id"),
          title: str(o, "title")!,
          company: String(userData.company || userData.slug || "Company"),
          location: str(o, "city") ? [str(o, "city"), str(o, "state"), str(o, "country")].filter(Boolean).join(", ") : str(o, "location"),
          workMode: o.telecommuting ? "remote" : detectWorkMode(str(o, "workplace"), str(o, "location")),
          employmentType: detectEmploymentType(str(o, "employment_type")),
          postedAt: parseDate(str(o, "published_on", "created_at")),
          url: str(o, "url", "shortlink"),
          description: stripHtml(str(o, "description")),
          skills: strArray(o, "department"),
        }));
        return { jobs: jobs.filter((j) => atsFilter(q, j)) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const breezy: Source = {
  id: "breezy",
  tier: "http",
  plan: () => [],
  handle: {
    "breezy:board"({ json, body, q, userData, url }) {
      try {
        const parsed = (json ?? (body ? tryJson(body) : null)) as Item[] | null;
        if (!Array.isArray(parsed) || !parsed.length) return { jobs: extractGeneric(body, url).filter((j) => atsFilter(q, j)) };

        const jobs = parsed.map<RawJob>((o) => ({
          sourceJobId: str(o, "_id", "id"),
          title: str(o, "name")!,
          company: String(userData.company || userData.slug || "Company"),
          location: str(o, "location.name") || [str(o, "location.city"), str(o, "location.state"), str(o, "location.country.name")].filter(Boolean).join(", ") || null,
          workMode: first(o, "type.remote", "location.is_remote") === true ? "remote" : detectWorkMode(str(o, "location.name")),
          employmentType: detectEmploymentType(str(o, "type.name", "type.id")),
          postedAt: parseDate(str(o, "updated", "created")),
          url: str(o, "url"),
          description: stripHtml(str(o, "description")),
          skills: strArray(o, "department"),
        }));
        return { jobs: jobs.filter((j) => atsFilter(q, j)) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const recruitee: Source = {
  id: "recruitee",
  tier: "http",
  plan: () => [],
  handle: {
    "recruitee:board"({ json, body, q, userData, url }) {
      try {
        const parsed = (json ?? (body ? tryJson(body) : null)) as { offers?: Item[] } | null;
        const rawJobs = parsed?.offers ?? [];
        if (!rawJobs.length) return { jobs: extractGeneric(body, url).filter((j) => atsFilter(q, j)) };

        const jobs = rawJobs.map<RawJob>((o) => ({
          sourceJobId: str(o, "id"),
          title: str(o, "title")!,
          company: String(userData.company || userData.slug || "Company"),
          location: str(o, "location", "city"),
          workMode: o.remote ? "remote" : detectWorkMode(str(o, "location")),
          employmentType: detectEmploymentType(str(o, "employment_type_code")),
          postedAt: parseDate(str(o, "published_at", "created_at")),
          url: str(o, "careers_url"),
          description: stripHtml(str(o, "description")),
          skills: strArray(o, "department"),
        }));
        return { jobs: jobs.filter((j) => atsFilter(q, j)) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

export function boardRequests(boards: string[]): Req[] {
  return boards.flatMap((b) => {
    const p = parseBoard(b.trim());
    if (!p) return [];
    const company = p.slug;
    const userData = { company, slug: p.slug, domain: p.domain, subpath: p.subpath };

    switch (p.ats) {
      case "greenhouse":
        return [{ url: `https://boards-api.greenhouse.io/v1/boards/${p.slug}/jobs?content=true`, label: "greenhouse:board", userData }];
      case "lever":
        return [{ url: `https://api.lever.co/v0/postings/${p.slug}?mode=json`, label: "lever:board", userData }];
      case "ashby":
        return [{ url: `https://api.ashbyhq.com/posting-api/job-board/${p.slug}?includeCompensation=true`, label: "ashby:board", userData }];
      case "smartrecruiters":
        return [{ url: `https://api.smartrecruiters.com/v1/companies/${p.slug}/postings?limit=100`, label: "smartrecruiters:board", userData }];
      case "workday": {
        const domain = p.domain || `${p.slug}.myworkdayjobs.com`;
        const board = p.subpath || "External";
        return [{ url: `https://${domain}/wday/cxs/${p.slug}/${board}/jobs`, label: "workday:board", userData }];
      }
      case "jobvite":
        return [{ url: `https://app.jobvite.com/CompanyJobs/Xml.aspx?c=${p.slug}`, label: "jobvite:board", userData }];
      case "workable":
        return [{ url: `https://apply.workable.com/api/v3/accounts/${p.slug}/jobs`, label: "workable:board", userData }];
      case "breezy":
        return [{ url: `https://${p.slug}.breezy.hr/json`, label: "breezy:board", userData }];
      case "recruitee":
        return [{ url: `https://${p.slug}.recruitee.com/api/offers/`, label: "recruitee:board", userData }];
      default:
        return [];
    }
  });
}

// ================================================================ Browser tier
// Cloudflare / DataDome / PerimeterX protected. Run in Playwright with residential proxy.

// Indeed: jobs live in window.mosaic.providerData["mosaic-provider-jobcards"].
const indeed: Source = {
  id: "indeed",
  tier: "browser",
  plan: (q) => Array.from({ length: Math.min(10, pages(q, 15)) }, (_, i) => ({ url: buildIndeedUrl(q, i * 10), label: "indeed:list" })),
  fromUrl: (url, q) => Array.from({ length: Math.min(10, pages(q, 15)) }, (_, i) => ({ url: i ? `${url}&start=${i * 10}` : url, label: "indeed:list" })),
  handle: {
    "indeed:list"({ body, url }) {
      try {
        const m = body.match(/window\.mosaic\.providerData\["mosaic-provider-jobcards"\]\s*=\s*(\{[\s\S]*?\});\s*window\.mosaic/);
        const origin = new URL(url).origin;
        if (!m) return { jobs: extractGeneric(body, origin) };
        const results = (JSON.parse(m[1]!)?.metaData?.mosaicProviderJobCardsModel?.results ?? []) as Item[];
        return {
          jobs: results.map((o) => ({
            sourceJobId: str(o, "jobkey"),
            title: str(o, "displayTitle", "title")!,
            company: str(o, "company", "truncatedCompany"),
            location: str(o, "formattedLocation"),
            workMode: detectWorkMode(str(o, "remoteLocation") === "true" ? true : null, str(o, "formattedLocation")),
            employmentType: detectEmploymentType(strArray(o, "jobTypes").join(" ")),
            salary: num(o, "extractedSalary.min")
              ? buildSalary({ min: num(o, "extractedSalary.min"), max: num(o, "extractedSalary.max"), period: str(o, "extractedSalary.type"), raw: str(o, "salarySnippet.text"), currency: str(o, "salarySnippet.currency") })
              : buildSalary(str(o, "salarySnippet.text", "estimatedSalary.formattedRange")),
            postedAt: parseDate(o.pubDate),
            url: `${origin}/viewjob?jk=${str(o, "jobkey")}`,
            applyUrl: str(o, "thirdPartyApplyUrl"),
            description: stripHtml(str(o, "snippet")),
            extra: { rating: o.companyRating, reviews: o.companyReviewCount, urgentlyHiring: o.urgentlyHiring, sponsored: o.sponsored },
          })),
        };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const GD_DOMAIN: Record<string, string> = { US: "glassdoor.com", CA: "glassdoor.ca", GB: "glassdoor.co.uk", IE: "glassdoor.ie", AU: "glassdoor.com.au", IN: "glassdoor.co.in", DE: "glassdoor.de", FR: "glassdoor.fr" };
const glassdoor: Source = {
  id: "glassdoor",
  tier: "browser",
  plan(q) {
    const p = new URLSearchParams({ "sc.keyword": kw(q), locKeyword: q.location, suggestCount: "0", suggestChosen: "false" });
    if (q.postedWithinDays) p.set("fromAge", String(q.postedWithinDays));
    if (q.remoteOnly) p.set("remoteWorkType", "1");
    if (q.minSalary) p.set("minSalary", String(q.minSalary));
    if (q.radiusMiles != null) p.set("radius", String(q.radiusMiles));
    return [{ url: `https://www.${GD_DOMAIN[q.country] ?? "glassdoor.com"}/Job/jobs.htm?${p}`, label: "glassdoor:list" }];
  },
  fromUrl: (url) => [{ url, label: "glassdoor:list" }],
  handle: {
    "glassdoor:list"({ body, url }) {
      try {
        const origin = new URL(url).origin;
        return { jobs: extractGeneric(body, origin).map((j) => ({ ...j, url: j.url?.startsWith("http") ? j.url : absUrl(j.url ?? null, origin) })) };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const upwork: Source = {
  id: "upwork",
  tier: "browser",
  plan: (q) => Array.from({ length: Math.min(10, pages(q, 50)) }, (_, i) => ({
    url: `https://www.upwork.com/nx/search/jobs/?q=${enc(kw(q))}&sort=recency&per_page=50&page=${i + 1}`, label: "upwork:list",
  })),
  fromUrl: (url) => [{ url, label: "upwork:list" }],
  handle: {
    "upwork:list"({ body, url }) {
      try {
        return {
          jobs: extractGeneric(body, "https://www.upwork.com").map((j) => {
            const cipher = j.url?.match(/~\w+/)?.[0] ?? (j.sourceJobId?.startsWith("~") ? j.sourceJobId : null);
            return { ...j, company: j.company ?? "Upwork client", workMode: "remote", employmentType: "freelance", url: cipher ? `https://www.upwork.com/jobs/${cipher}` : j.url };
          }),
        };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const ziprecruiter: Source = {
  id: "ziprecruiter",
  tier: "browser",
  plan(q) {
    const p = new URLSearchParams({ search: kw(q), location: q.remoteOnly ? "Remote" : q.location });
    if (q.radiusMiles) p.set("radius", String(q.radiusMiles));
    if (q.postedWithinDays) p.set("days", String(q.postedWithinDays));
    if (q.minSalary) p.set("refine_by_salary", String(q.minSalary));
    return Array.from({ length: Math.min(10, pages(q, 20)) }, (_, i) => ({ url: `https://www.ziprecruiter.com/jobs-search?${p}&page=${i + 1}`, label: "ziprecruiter:list" }));
  },
  fromUrl: (url) => [{ url, label: "ziprecruiter:list" }],
  handle: { "ziprecruiter:list": ({ body }) => ({ jobs: extractGeneric(body, "https://www.ziprecruiter.com") }) },
};

// SimplyHired is Indeed-owned: same job-type codes, Next.js pageProps.jobs.
const simplyhired: Source = {
  id: "simplyhired",
  tier: "browser",
  plan(q) {
    const p = new URLSearchParams({ q: kw(q), l: q.remoteOnly ? "Remote" : q.location, sb: "dd" });
    if (q.radiusMiles) p.set("mi", String(q.radiusMiles));
    if (q.postedWithinDays) p.set("t", String(q.postedWithinDays));
    if (q.minSalary) p.set("mip", String(q.minSalary));
    const jt = indeedTypeCodes(q.employmentTypes)[0];
    if (jt) p.set("jt", jt);
    return [{ url: `https://www.simplyhired.com/search?${p}`, label: "simplyhired:list" }];
  },
  fromUrl: (url) => [{ url, label: "simplyhired:list" }],
  handle: {
    "simplyhired:list"({ body, url }) {
      try {
        const m = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        const list = (m ? JSON.parse(m[1]!)?.props?.pageProps?.jobs : null) as Item[] | null;
        if (!list) return { jobs: extractGeneric(body, "https://www.simplyhired.com") };
        return {
          jobs: list.map((o) => ({
            sourceJobId: str(o, "jobKey"), title: str(o, "title")!, company: str(o, "company"), location: str(o, "location"),
            salary: buildSalary(str(o, "salaryInfo")), postedAt: parseDate(o.dateOnIndeed), description: str(o, "snippet"),
            workMode: detectWorkMode(str(o, "location")), url: `https://www.simplyhired.com/job/${str(o, "jobKey")}`,
          })),
        };
      } catch {
        return { jobs: extractGeneric(body, url) };
      }
    },
  },
};

const monster: Source = {
  id: "monster",
  tier: "browser",
  plan: (q) => [{ url: `https://www.monster.com/jobs/search?q=${enc(kw(q))}&where=${enc(q.remoteOnly ? "remote" : q.location)}${q.postedWithinDays ? `&recency=last+${q.postedWithinDays}+days` : ""}`, label: "monster:list" }],
  fromUrl: (url) => [{ url, label: "monster:list" }],
  handle: { "monster:list": ({ body }) => ({ jobs: extractGeneric(body, "https://www.monster.com") }) },
};

// Any other URL: career pages, niche boards. JSON-LD + embedded JSON, via browser.
const generic: Source = {
  id: "generic",
  tier: "browser",
  plan: () => [],
  fromUrl: (url) => [{ url, label: "generic:page" }],
  handle: { "generic:page": ({ body, url }) => ({ jobs: extractGeneric(body, url) }) },
};

export const SOURCES: Record<SourceId, Source> = {
  linkedin, indeed, glassdoor, wellfound, upwork, ziprecruiter, dice, simplyhired, monster, builtin,
  remoteok, remotive, himalayas, weworkremotely, hackernews, greenhouse, lever, ashby,
  smartrecruiters, workday, jobvite, workable, breezy, recruitee, generic,
};

export const sourceOfLabel = (label: string) => {
  const prefix = label.split(":")[0];
  if (prefix === "wwr") return "weworkremotely";
  if (prefix === "hn") return "hackernews";
  return prefix as SourceId;
};

export { genericJob };
