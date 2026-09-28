import { Actor, log } from "apify";
import { CheerioCrawler, PlaywrightCrawler, RequestQueue, type ProxyConfiguration } from "crawlee";
import { InputSchema, toQuery } from "./input.ts";
import { SOURCES, boardRequests, sourceOfLabel, type Ctx, type Req } from "./sources.ts";
import { cleanUrl, detectSource } from "./lib/urls.ts";
import { daysAgo } from "./lib/dates.ts";
import { hash, normCity, normCompany, normTitle } from "./lib/text.ts";
import type { Job, RawJob, SourceId } from "./model.ts";

await Actor.init();
const input = InputSchema.parse((await Actor.getInput()) ?? {});
const q = toQuery(input);
if (input.debug) log.setLevel(log.LEVELS.DEBUG);

// ---------------------------------------------------------------- Plan
const plan: Req[] = [];
const overridden = new Set<SourceId>();
for (const raw of input.startUrls) {
  const board = boardRequests([raw]);
  if (board.length) { plan.push(...board); continue; }
  const { url } = cleanUrl(raw);
  const id = detectSource(url) ?? "generic";
  const src = SOURCES[id].fromUrl ? SOURCES[id] : SOURCES.generic;
  plan.push(...src.fromUrl!(url, q));
  overridden.add(id);
}
for (const id of input.sources) if (!overridden.has(id)) plan.push(...SOURCES[id].plan(q, input));
plan.push(...boardRequests(input.companyBoards));

const tierOf = (label: string) => SOURCES[sourceOfLabel(label)]?.tier ?? "browser";
const httpReqs = plan.filter((r) => tierOf(r.label) === "http");
const browserReqs = plan.filter((r) => tierOf(r.label) === "browser");
log.info(`Plan: ${httpReqs.length} http + ${browserReqs.length} browser requests across ${new Set(plan.map((r) => sourceOfLabel(r.label))).size} sources`);

// ---------------------------------------------------------------- Collect
const collected: { source: SourceId; job: RawJob }[] = [];
const perSource = new Map<SourceId, number>();
const errors: Record<string, string[]> = {};

function handle(label: string, ctx: Ctx): Req[] {
  const source = sourceOfLabel(label);
  const fn = SOURCES[source]?.handle[label];
  if (!fn) throw new Error(`No handler for ${label}`);
  const { jobs, next = [] } = fn(ctx);
  const have = perSource.get(source) ?? 0;
  const room = Math.max(0, q.maxResultsPerSource - have);
  const valid = jobs.filter((j) => j.title).slice(0, room);
  for (const job of valid) collected.push({ source, job });
  perSource.set(source, have + valid.length);
  log.info(`[${source}] +${valid.length} (${have + valid.length}) ${label}`);
  // Stop paginating once a source is full; detail pages still get fetched.
  return have + valid.length >= q.maxResultsPerSource ? next.filter((n) => n.label.endsWith(":detail")) : next;
}

const toCrawlee = (r: Req) => ({ url: r.url, label: r.label, headers: r.headers, uniqueKey: r.uniqueKey, userData: { ...r.userData, label: r.label } });
const failed = (source: string, msg: string) => ((errors[source] ??= []).push(msg.slice(0, 300)));

const httpProxy: ProxyConfiguration | undefined = input.proxyConfiguration
  ? await Actor.createProxyConfiguration(input.proxyConfiguration as never)
  : undefined;
const browserProxy: ProxyConfiguration | undefined = await Actor.createProxyConfiguration(
  (input.browserProxyConfiguration ?? (Actor.isAtHome() ? { groups: ["RESIDENTIAL"], countryCode: q.country } : undefined)) as never,
);

const httpQueue = await RequestQueue.open(`http-${Date.now()}`);
const browserQueue = await RequestQueue.open(`browser-${Date.now()}`);

const http = new CheerioCrawler({
  requestQueue: httpQueue,
  proxyConfiguration: httpProxy,
  maxConcurrency: input.maxConcurrency,
  maxRequestRetries: input.maxRequestRetries,
  maxRequestsPerMinute: 120,
  additionalMimeTypes: ["application/json", "application/rss+xml", "application/xml", "text/xml"],
  useSessionPool: true,
  sessionPoolOptions: { blockedStatusCodes: [401, 403, 429, 999] },
  async requestHandler({ request, body, json, crawler }) {
    const label = String(request.userData.label ?? request.label);
    const next = handle(label, { url: request.loadedUrl ?? request.url, body: body.toString(), json, userData: request.userData, q, input });
    const http = next.filter((n) => tierOf(n.label) === "http");
    if (http.length) await crawler.addRequests(http.map(toCrawlee));
  },
  async failedRequestHandler({ request }, err) {
    const label = String(request.userData.label);
    failed(sourceOfLabel(label), `${request.url} → ${err.message}`);
    // Anti-bot page on a normally-open site (e.g. Wellfound Turnstile)? Retry once in a real browser.
    if (label === "wellfound:list") await browserQueue.addRequest({ ...toCrawlee({ url: request.url, label }), uniqueKey: `b:${request.url}` });
  },
});

const browser = new PlaywrightCrawler({
  requestQueue: browserQueue,
  proxyConfiguration: browserProxy,
  maxConcurrency: input.browserMaxConcurrency,
  maxRequestRetries: input.maxRequestRetries,
  navigationTimeoutSecs: 90,
  requestHandlerTimeoutSecs: 180,
  useSessionPool: true,
  persistCookiesPerSession: true,
  sessionPoolOptions: { blockedStatusCodes: [401, 403, 429] },
  browserPoolOptions: { useFingerprints: true },
  launchContext: { launchOptions: { headless: true } },
  preNavigationHooks: [
    async ({ page, request }) => {
      // Block heavy assets; capture every JSON response (GraphQL, XHR) the page loads.
      await page.route(/\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4)(\?|$)/i, (r) => r.abort());
      const captured: string[] = [];
      request.userData.__captured = captured;
      page.on("response", async (res) => {
        if (!/json/.test(res.headers()["content-type"] ?? "")) return;
        try { captured.push(await res.text()); } catch { /* ignore */ }
      });
    },
  ],
  async requestHandler({ page, request, session }) {
    const label = String(request.userData.label ?? request.label);
    const title = await page.title();
    if (/just a moment|attention required|access denied|security|verify you are human|blocked/i.test(title)) {
      await page.waitForTimeout(8000); // give Turnstile/JS challenge a chance to auto-solve
      if (/just a moment|attention required|access denied|security|verify/i.test(await page.title())) {
        session?.retire();
        throw new Error(`Challenge page: "${title}"`);
      }
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    // Infinite-scroll / "show more" boards: nudge a few times.
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 4000);
      const more = page.locator('button:has-text("Show more jobs"), button:has-text("Load more")').first();
      if (await more.isVisible().catch(() => false)) await more.click().catch(() => {});
      await page.waitForTimeout(1200);
    }
    const captured = (request.userData.__captured as string[] | undefined) ?? [];
    const body = (await page.content()) + captured.map((c) => `<script type="application/json">${c}</script>`).join("");
    handle(label, { url: page.url(), body, json: null, userData: request.userData, q, input });
  },
  failedRequestHandler({ request }, err) {
    failed(sourceOfLabel(String(request.userData.label)), `${request.url} → ${err.message}`);
  },
});

await httpQueue.addRequests(httpReqs.map(toCrawlee));
await browserQueue.addRequests(browserReqs.map(toCrawlee));
// Run both tiers in parallel. Wellfound fallbacks can land in the browser queue late, so drain it again.
await Promise.all([httpReqs.length ? http.run() : null, browserReqs.length ? browser.run() : null]);
if (!(await browserQueue.isFinished())) await browser.run();

// ---------------------------------------------------------------- Normalize, dedupe, filter, score
const now = new Date();
const scrapedAt = now.toISOString();
const byId = new Map<string, Job>();
const richness = (j: RawJob) => Object.values(j).filter((v) => v != null && v !== "" && !(Array.isArray(v) && !v.length)).length;

for (const { source, job } of collected) {
  const id = hash(`${normCompany(job.company)}|${normTitle(job.title)}|${normCity(job.location)}`);
  const cur = byId.get(id);
  if (cur) {
    if (!cur.seenOn.includes(source)) cur.seenOn.push(source);
    if (job.url) cur.urls[source] ??= job.url;
    // Fill gaps from the other board's copy.
    for (const [k, v] of Object.entries(job)) if ((cur as never as Record<string, unknown>)[k] == null && v != null) (cur as never as Record<string, unknown>)[k] = v;
    if (!cur.salary?.annualMin && job.salary?.annualMin) cur.salary = job.salary;
    if (job.postedAt && cur.postedAt && job.postedAt < cur.postedAt) cur.postedAt = job.postedAt;
    if (richness(job) > richness(cur as never)) cur.description = job.description ?? cur.description;
    continue;
  }
  byId.set(id, {
    id, source, seenOn: [source], urls: job.url ? { [source]: job.url } : {},
    sourceJobId: job.sourceJobId ?? null, title: job.title.trim(), company: job.company?.trim() ?? null, location: job.location ?? null,
    workMode: job.workMode ?? null, employmentType: job.employmentType ?? null, salary: job.salary ?? null, postedAt: job.postedAt ?? null,
    url: job.url ?? null, applyUrl: job.applyUrl ?? null, description: job.description ?? null, skills: job.skills ?? [],
    seniority: job.seniority ?? null, companyUrl: job.companyUrl ?? null, companyLogo: job.companyLogo ?? null, applicants: job.applicants ?? null,
    score: 0, scoreReasons: [], isNew: true, scrapedAt, extra: job.extra ?? {},
  });
}

const NO_GEO = new Set<SourceId>(["builtin", "greenhouse", "lever", "ashby", "hackernews"]);
const re = (s: string) => new RegExp(s, "i");
const inc = input.titleInclude.map(re), exc = input.titleExclude.map(re);
const badCo = new Set(input.excludeCompanies.map(normCompany));
const kws = q.keywords.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

let jobs = [...byId.values()].filter((j) => {
  if (inc.length && !inc.some((r) => r.test(j.title))) return false;
  if (exc.some((r) => r.test(j.title))) return false;
  if (badCo.has(normCompany(j.company))) return false;
  if (q.remoteOnly && j.workMode && j.workMode !== "remote") return false;
  // Boards with no native geo filter: keep only remote roles or ones in the searched city.
  const city = q.location.split(",")[0]!.trim().toLowerCase();
  if (city && !q.remoteOnly && NO_GEO.has(j.source) && j.workMode !== "remote" && !(j.location ?? "").toLowerCase().includes(city)) return false;
  if (q.minSalary && (j.salary?.annualMax ?? null) != null && j.salary!.annualMax! < q.minSalary) return false;
  if (q.minSalary && !input.keepUnknownSalary && j.salary?.annualMax == null) return false;
  const age = daysAgo(j.postedAt, now);
  if (q.postedWithinDays && age != null && age > q.postedWithinDays + 1) return false;
  return true;
});

for (const j of jobs) {
  const r: string[] = [];
  let s = 0;
  const t = j.title.toLowerCase();
  const hits = kws.filter((w) => t.includes(w)).length;
  if (kws.length) { const p = Math.round((hits / kws.length) * 40); s += p; if (p) r.push(`title matches ${hits}/${kws.length} keywords`); } else s += 20;
  if (j.salary?.annualMax) { s += 20; r.push("salary listed"); if (q.minSalary && j.salary.annualMin && j.salary.annualMin >= q.minSalary) { s += 5; r.push("salary ≥ target"); } }
  const age = daysAgo(j.postedAt, now);
  if (age != null) { const p = Math.max(0, Math.round(20 - age)); s += p; if (age <= 3) r.push("fresh (≤3d)"); }
  if (j.workMode === "remote") { s += 5; r.push("remote"); }
  if (j.seenOn.length > 1) { s += 10; r.push(`on ${j.seenOn.length} boards`); }
  j.score = Math.min(100, s);
  j.scoreReasons = r;
}

// Incremental mode: remember what we've already shown you.
const state = await Actor.openKeyValueStore("jobhound-state");
const seenKey = `seen-${input.stateKey}`;
const seen = new Set((await state.getValue<string[]>(seenKey)) ?? []);
for (const j of jobs) j.isNew = !seen.has(j.id);
if (input.onlyNew) jobs = jobs.filter((j) => j.isNew);
await state.setValue(seenKey, [...new Set([...seen, ...jobs.map((j) => j.id)])].slice(-50000));

jobs.sort((a, b) => b.score - a.score || (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
for (let i = 0; i < jobs.length; i += 500) await Actor.pushData(jobs.slice(i, i + 500));

const summary = {
  query: q,
  totalRaw: collected.length,
  totalUnique: byId.size,
  totalOutput: jobs.length,
  crossPosted: jobs.filter((j) => j.seenOn.length > 1).length,
  perSource: Object.fromEntries(perSource),
  errors,
  finishedAt: new Date().toISOString(),
};
await Actor.setValue("SUMMARY", summary);
log.info(`Done: ${jobs.length} jobs (${collected.length} raw, ${summary.crossPosted} cross-posted). Per source: ${JSON.stringify(summary.perSource)}`);
if (Object.keys(errors).length) log.warning(`Errors: ${JSON.stringify(Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.length])))}`);
await Actor.exit();
