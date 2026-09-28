import * as cheerio from "cheerio";
import { absUrl, num, str, strArray, stripHtml, type Item } from "./lib/extract.ts";
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
    if (q.remoteOnly) p.set("f_WT", "2");
    const jt = [...new Set(q.employmentTypes.map((t) => LI_TYPES[t]).filter(Boolean))];
    if (jt.length) p.set("f_JT", jt.join(","));
    if (q.minSalary) p.set("f_SB2", String(Math.min(9, Math.max(1, Math.floor(q.minSalary / 20000) - 1)))); // 1=$40k … 9=$200k
    return [{ url: linkedinListUrl(p, 0), label: "linkedin:list", userData: { params: p.toString(), start: 0 } }];
  },
  fromUrl(url) {
    const p = new URL(url).searchParams;
    for (const k of ["currentJobId", "trk", "refId", "trackingId", "position", "pageNum", "origin"]) p.delete(k);
    return [{ url: linkedinListUrl(p, 0), label: "linkedin:list", userData: { params: p.toString(), start: 0 } }];
  },
  handle: {
    "linkedin:list"({ body, userData, q, input }) {
      const $ = cheerio.load(body);
      const jobs: RawJob[] = [];
      const next: Req[] = [];
      $("li").each((_, li) => {
        const el = $(li);
        const id = el.find("[data-entity-urn]").attr("data-entity-urn")?.split(":").pop() ?? null;
        const title = el.find(".base-search-card__title").text().trim();
        if (!title) return;
        const url = el.find("a.base-card__full-link").attr("href")?.split("?")[0] ?? null;
        const job: RawJob = {
          sourceJobId: id,
          title,
          company: el.find(".base-search-card__subtitle").text().trim() || null,
          location: el.find(".job-search-card__location").text().trim() || null,
          postedAt: parseDate(el.find("time").attr("datetime")) ?? parseDate(el.find("time").text()),
          salary: buildSalary(el.find(".job-search-card__salary-info").text().trim() || null),
          url,
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
      return { jobs, next };
    },
    "linkedin:detail"({ body, userData }) {
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
    },
  },
};

// ---------------------------------------------------------------- Dice
// Dice's own frontend search API. 100 per page.
const DICE_DAYS: Record<number, string> = { 1: "ONE", 3: "THREE", 7: "SEVEN", 14: "THIRTY", 30: "THIRTY" };
const DICE_TYPES: Record<string, string> = { full_time: "FULLTIME", part_time: "PARTTIME", contract: "CONTRACTS", freelance: "CONTRACTS", temporary: "CONTRACTS" };
const dice: Source = {
  id: "dice",
  tier: "http",
  plan(q, input) {
    const p = new URLSearchParams({ q: kw(q), countryCode2: q.country, page: "1", pageSize: "100", language: "en", sort: "date" });
    if (q.location) p.set("location", q.location);
    if (q.radiusMiles) { p.set("radius", String(q.radiusMiles)); p.set("radiusUnit", "mi"); }
    if (q.postedWithinDays) p.set("filters.postedDate", DICE_DAYS[q.postedWithinDays]!);
    if (q.remoteOnly) p.set("filters.workplaceTypes", "Remote");
    const t = [...new Set(q.employmentTypes.map((x) => DICE_TYPES[x]).filter(Boolean))];
    if (t.length) p.set("filters.employmentType", t.join("|"));
    return [{ url: `https://job-search-api.svc.dhigroupinc.com/v1/dice/jobs/search?${p}`, label: "dice:list", headers: { "x-api-key": input.diceApiKey, origin: "https://www.dice.com" } }];
  },
  handle: {
    "dice:list"({ json, url, q, input }) {
      const d = json as { data?: Item[]; meta?: { pageCount?: number; currentPage?: number } };
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
      }));
      const page = d.meta?.currentPage ?? 1;
      const next: Req[] = [];
      if (page < (d.meta?.pageCount ?? 1) && page < pages(q, 100)) {
        const u = new URL(url);
        u.searchParams.set("page", String(page + 1));
        next.push({ url: u.toString(), label: "dice:list", headers: { "x-api-key": input.diceApiKey, origin: "https://www.dice.com" } });
      }
      return { jobs, next };
    },
  },
};

// ---------------------------------------------------------------- Wellfound
// Server-rendered Apollo cache in __NEXT_DATA__. Falls back to browser tier if challenged.
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
    "wellfound:list"({ body }) {
      const m = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (!m) throw new Error("wellfound: no __NEXT_DATA__ (challenge page?)");
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
      return { jobs };
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
    "builtin:list"({ body, input }) {
      const $ = cheerio.load(body);
      const jobs: RawJob[] = [];
      const next: Req[] = [];
      $('[data-id="job-card"]').each((_, c) => {
        const el = $(c);
        const a = el.find('[data-id="job-card-title"]');
        const url = absUrl(a.attr("href") ?? null, "https://builtin.com");
        const texts = el.find(".bounded-attribute-section span").map((_, s) => $(s).text().trim()).get().filter(Boolean);
        const job: RawJob = {
          sourceJobId: url?.split("/").pop() ?? null,
          title: a.text().trim(),
          company: el.find('[data-id="company-title"]').text().trim() || null,
          postedAt: parseDate(texts.find((t) => /ago|today|yesterday/i.test(t))),
          location: texts.find((t) => /,|remote|hybrid/i.test(t) && !/ago/i.test(t)) ?? null,
          salary: buildSalary(texts.find((t) => /\$|K\b/.test(t) && /\d/.test(t)) ?? null),
          url,
        };
        job.workMode = detectWorkMode(texts.join(" "));
        if (input.fetchDetails && url) next.push({ url, label: "builtin:detail", userData: { job } });
        else if (job.title) jobs.push(job);
      });
      return { jobs, next };
    },
    "builtin:detail"({ body, url, userData }) {
      const base = userData.job as RawJob;
      const ld = extractGeneric(body, url)[0];
      return { jobs: [{ ...base, ...Object.fromEntries(Object.entries(ld ?? {}).filter(([, v]) => v != null && v !== "")), title: base.title, url: base.url } as RawJob] };
    },
  },
};

// ---------------------------------------------------------------- Remote boards (public APIs / feeds)
const remoteok: Source = {
  id: "remoteok",
  tier: "http",
  plan: (q) => [{ url: `https://remoteok.com/api${q.keywords ? `?tag=${enc(slug(q.keywords.split(/\s+/).pop()!))}` : ""}`, label: "remoteok:api" }],
  handle: {
    "remoteok:api"({ json, q }) {
      const arr = ((json as Item[]) ?? []).filter((o) => o.position);
      return {
        jobs: arr.filter((o) => matchesKeywords(q, str(o, "position"), strArray(o, "tags").join(" "))).map((o) => ({
          sourceJobId: str(o, "id"),
          title: str(o, "position")!,
          company: str(o, "company"),
          location: str(o, "location") ?? "Remote",
          workMode: "remote",
          salary: num(o, "salary_min") ? buildSalary({ min: num(o, "salary_min"), max: num(o, "salary_max"), period: "year", currency: "USD" }) : null,
          postedAt: parseDate(o.epoch),
          url: str(o, "url"), // RemoteOK ToS: link back to the listing
          applyUrl: str(o, "apply_url"),
          description: stripHtml(str(o, "description")),
          skills: strArray(o, "tags"),
          companyLogo: str(o, "company_logo"),
        })),
      };
    },
  },
};

const remotive: Source = {
  id: "remotive",
  tier: "http",
  plan: (q) => [{ url: `https://remotive.com/api/remote-jobs?search=${enc(kw(q))}&limit=${q.maxResultsPerSource}`, label: "remotive:api" }],
  handle: {
    "remotive:api": ({ json }) => ({
      jobs: (((json as { jobs?: Item[] }).jobs) ?? []).map((o) => ({
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
    }),
  },
};

const himalayas: Source = {
  id: "himalayas",
  tier: "http",
  plan: (q) => [{ url: `https://himalayas.app/jobs/api/search?q=${enc(kw(q))}&page=1`, label: "himalayas:api", userData: { page: 1 } }],
  handle: {
    "himalayas:api"({ json, q, userData }) {
      const d = json as { jobs?: Item[] };
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
      const page = Number(userData.page);
      const next = jobs.length && page < pages(q, 20) ? [{ url: `https://himalayas.app/jobs/api/search?q=${enc(kw(q))}&page=${page + 1}`, label: "himalayas:api", userData: { page: page + 1 } }] : [];
      return { jobs, next };
    },
  },
};

const weworkremotely: Source = {
  id: "weworkremotely",
  tier: "http",
  plan: () => [{ url: "https://weworkremotely.com/remote-jobs.rss", label: "wwr:rss" }],
  handle: {
    "wwr:rss"({ body, q }) {
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
          title, company: company?.trim() ?? null, workMode: "remote",
          location: el.find("region").text() || "Remote",
          postedAt: parseDate(el.find("pubDate").text()),
          url: el.find("link").text() || el.find("guid").text(),
          employmentType: detectEmploymentType(el.find("type").text()),
          description,
          skills: el.find("skills").text().split(",").map((s) => s.trim()).filter(Boolean),
        });
      });
      return { jobs: jobs.slice(0, q.maxResultsPerSource) };
    },
  },
};

// Hacker News "Ask HN: Who is hiring?" — the latest monthly thread, parsed.
const hackernews: Source = {
  id: "hackernews",
  tier: "http",
  plan: () => [{ url: "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5", label: "hn:thread" }],
  handle: {
    "hn:thread"({ json }) {
      const hit = ((json as { hits: Item[] }).hits ?? []).find((h) => /who is hiring/i.test(String(h.title)));
      return { jobs: [], next: hit ? [{ url: `https://hn.algolia.com/api/v1/items/${hit.objectID}`, label: "hn:items" }] : [] };
    },
    "hn:items"({ json, q }) {
      const kids = ((json as { children?: Item[] }).children ?? []).filter((c) => c.text);
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
    },
  },
};

// ---------------------------------------------------------------- Company ATS boards
// Jobs land here first; LinkedIn/Indeed syndicate them later.
export function parseBoard(s: string): { ats: "greenhouse" | "lever" | "ashby"; slug: string } | null {
  const m =
    s.match(/^(greenhouse|lever|ashby):([\w.-]+)$/i) ??
    s.match(/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w.-]+)/i)?.map((x, i) => (i === 1 ? "greenhouse" : i === 2 ? x : x)) ??
    null;
  if (m && m.length === 3) return { ats: m[1]!.toLowerCase() as "greenhouse", slug: m[2]! };
  const gh = s.match(/greenhouse\.io\/([\w.-]+)/i);
  if (gh) return { ats: "greenhouse", slug: gh[1]! };
  const lv = s.match(/jobs\.lever\.co\/([\w.-]+)/i);
  if (lv) return { ats: "lever", slug: lv[1]! };
  const ab = s.match(/jobs\.ashbyhq\.com\/([\w.-]+)/i);
  if (ab) return { ats: "ashby", slug: ab[1]! };
  return null;
}

const atsFilter = (q: SearchQuery, j: RawJob) =>
  matchesKeywords(q, j.title) && (!q.remoteOnly || j.workMode === "remote") &&
  (!q.location || q.remoteOnly || !j.location || j.workMode === "remote" || j.location.toLowerCase().includes(q.location.split(",")[0]!.toLowerCase()));

const greenhouse: Source = {
  id: "greenhouse", tier: "http", plan: () => [],
  handle: {
    "greenhouse:board"({ json, q, userData }) {
      const jobs = (((json as { jobs?: Item[] }).jobs) ?? []).map<RawJob>((o) => ({
        sourceJobId: str(o, "id"), title: str(o, "title")!, company: String(userData.company),
        location: str(o, "location.name"), workMode: detectWorkMode(str(o, "location.name")),
        postedAt: parseDate(str(o, "first_published", "updated_at")), url: str(o, "absolute_url"),
        description: stripHtml(stripHtml(str(o, "content"))),
      }));
      return { jobs: jobs.filter((j) => atsFilter(q, j)) };
    },
  },
};
const lever: Source = {
  id: "lever", tier: "http", plan: () => [],
  handle: {
    "lever:board"({ json, q, userData }) {
      const jobs = ((json as Item[]) ?? []).map<RawJob>((o) => ({
        sourceJobId: str(o, "id"), title: str(o, "text")!, company: String(userData.company),
        location: str(o, "categories.location"), workMode: detectWorkMode(str(o, "workplaceType"), str(o, "categories.location")),
        employmentType: detectEmploymentType(str(o, "categories.commitment")),
        salary: num(o, "salaryRange.min") ? buildSalary({ min: num(o, "salaryRange.min"), max: num(o, "salaryRange.max"), currency: str(o, "salaryRange.currency"), period: str(o, "salaryRange.interval")?.replace("per-", "") }) : null,
        postedAt: parseDate(o.createdAt), url: str(o, "hostedUrl"), applyUrl: str(o, "applyUrl"), description: str(o, "descriptionPlain"),
      }));
      return { jobs: jobs.filter((j) => atsFilter(q, j)) };
    },
  },
};
const ashby: Source = {
  id: "ashby", tier: "http", plan: () => [],
  handle: {
    "ashby:board"({ json, q, userData }) {
      const jobs = (((json as { jobs?: Item[] }).jobs) ?? []).filter((o) => o.isListed !== false).map<RawJob>((o) => ({
        sourceJobId: str(o, "id"), title: str(o, "title")!, company: String(userData.company),
        location: str(o, "location"), workMode: o.isRemote ? "remote" : detectWorkMode(str(o, "workplaceType"), str(o, "location")),
        employmentType: detectEmploymentType(str(o, "employmentType")?.replace(/([a-z])([A-Z])/g, "$1 $2")),
        salary: buildSalary(str(o, "compensation.compensationTierSummary", "compensation.scrapeableCompensationSalarySummary")),
        postedAt: parseDate(str(o, "publishedAt")), url: str(o, "jobUrl"), applyUrl: str(o, "applyUrl"), description: str(o, "descriptionPlain"),
      }));
      return { jobs: jobs.filter((j) => atsFilter(q, j)) };
    },
  },
};

export function boardRequests(boards: string[]): Req[] {
  return boards.flatMap((b) => {
    const p = parseBoard(b.trim());
    if (!p) return [];
    const company = p.slug;
    if (p.ats === "greenhouse") return [{ url: `https://boards-api.greenhouse.io/v1/boards/${p.slug}/jobs?content=true`, label: "greenhouse:board", userData: { company } }];
    if (p.ats === "lever") return [{ url: `https://api.lever.co/v0/postings/${p.slug}?mode=json`, label: "lever:board", userData: { company } }];
    return [{ url: `https://api.ashbyhq.com/posting-api/job-board/${p.slug}?includeCompensation=true`, label: "ashby:board", userData: { company } }];
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
    // Captured network JSON (GraphQL jobListings) + embedded Next.js data both land in body.
    "glassdoor:list"({ body, url }) {
      const origin = new URL(url).origin;
      return { jobs: extractGeneric(body, origin).map((j) => ({ ...j, url: j.url?.startsWith("http") ? j.url : absUrl(j.url ?? null, origin) })) };
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
    "upwork:list"({ body }) {
      return {
        jobs: extractGeneric(body, "https://www.upwork.com").map((j) => {
          const cipher = j.url?.match(/~\w+/)?.[0] ?? (j.sourceJobId?.startsWith("~") ? j.sourceJobId : null);
          return { ...j, company: j.company ?? "Upwork client", workMode: "remote", employmentType: "freelance", url: cipher ? `https://www.upwork.com/jobs/${cipher}` : j.url };
        }),
      };
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
    "simplyhired:list"({ body }) {
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
  remoteok, remotive, himalayas, weworkremotely, hackernews, greenhouse, lever, ashby, generic,
};

export const sourceOfLabel = (label: string) => label.split(":")[0] === "wwr" ? "weworkremotely" : label.split(":")[0] === "hn" ? "hackernews" : (label.split(":")[0] as SourceId);
export { genericJob };
