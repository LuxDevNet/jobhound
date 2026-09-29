import { Actor, log } from "apify";
import { CheerioCrawler, PlaywrightCrawler, RequestQueue, type ProxyConfiguration } from "crawlee";
import { InputSchema, toQuery } from "./input.ts";
import { SOURCES, boardRequests, sourceOfLabel, type Ctx, type Req } from "./sources.ts";
import { cleanUrl, detectSource, isDirectApplyUrl } from "./lib/urls.ts";
import { daysAgo } from "./lib/dates.ts";
import { detectSeniority, extractYearsOfExperience, hash, normCity, normCompany, normTitle } from "./lib/text.ts";
import { applyStealthToPage, getStealthHeaders } from "./lib/stealth.ts";
import { exportToFile, sendWebhook } from "./lib/export.ts";
import type { Job, RawJob, SourceId } from "./model.ts";

await Actor.init();
const input = InputSchema.parse((await Actor.getInput()) ?? {});
const q = toQuery(input);
if (input.debug) log.setLevel(log.LEVELS.DEBUG);

log.info("Jobhound pipeline initializing...", {
  keywords: q.keywords,
  location: q.location,
  country: q.country,
  sources: input.sources,
  maxResultsPerSource: q.maxResultsPerSource,
  remoteOnly: q.remoteOnly,
});

// ---------------------------------------------------------------- Plan
const plan: Req[] = [];
const overridden = new Set<SourceId>();

// Process explicitly provided search / board URLs
for (const raw of input.startUrls) {
  const board = boardRequests([raw]);
  if (board.length) {
    plan.push(...board);
    continue;
  }
  const { url } = cleanUrl(raw);
  const id = detectSource(url) ?? "generic";
  const src = SOURCES[id]?.fromUrl ? SOURCES[id] : SOURCES.generic;
  plan.push(...src.fromUrl!(url, q));
  overridden.add(id);
}

// Filter sources and boards if distributed sharding is enabled
const activeSources = input.shardTotal > 1
  ? input.sources.filter((_, idx) => idx % input.shardTotal === input.shardIndex)
  : input.sources;

const activeCompanyBoards = input.shardTotal > 1
  ? input.companyBoards.filter((_, idx) => idx % input.shardTotal === input.shardIndex)
  : input.companyBoards;

if (input.shardTotal > 1) {
  log.info(`[Distributed Mode] Running shard ${input.shardIndex + 1}/${input.shardTotal} (${activeSources.length} sources, ${activeCompanyBoards.length} ATS boards)`);
}

// Generate plans for configured sources that weren't overridden by explicit URLs
for (const id of activeSources) {
  if (!overridden.has(id) && SOURCES[id]) {
    plan.push(...SOURCES[id].plan(q, input));
  }
}

// Add company ATS boards (Greenhouse, Lever, Ashby, etc.)
plan.push(...boardRequests(activeCompanyBoards));

// Apply custom base URL overrides or proxy scraper wrappers
if (input.baseUrls && Object.keys(input.baseUrls).length > 0) {
  for (const r of plan) {
    const srcId = sourceOfLabel(r.label);
    const customBase = input.baseUrls[srcId] || input.baseUrls["*"];
    if (customBase) {
      try {
        const originalUrl = new URL(r.url);
        if (customBase.startsWith("http://") || customBase.startsWith("https://")) {
          const overrideUrl = new URL(customBase);
          if (customBase.includes("?url=") || customBase.includes("/api/")) {
            // Proxy scraper endpoint (e.g. Scrapling / ScrapingBee / ScraperAPI)
            r.url = customBase.includes("?")
              ? `${customBase}&url=${encodeURIComponent(r.url)}`
              : `${customBase}?url=${encodeURIComponent(r.url)}`;
          } else {
            // Domain/host mirror override
            originalUrl.protocol = overrideUrl.protocol;
            originalUrl.host = overrideUrl.host;
            r.url = originalUrl.toString();
          }
        }
      } catch (err: any) {
        log.warning(`Could not apply baseUrls override "${customBase}" to "${r.url}": ${err.message}`);
      }
    }
  }
}

const tierOf = (label: string): "http" | "browser" => SOURCES[sourceOfLabel(label)]?.tier ?? "browser";
const httpReqs = plan.filter((r) => tierOf(r.label) === "http");
const browserReqs = plan.filter((r) => tierOf(r.label) === "browser");

log.info(
  `Plan generated: ${httpReqs.length} HTTP + ${browserReqs.length} Browser requests across ${
    new Set(plan.map((r) => sourceOfLabel(r.label))).size
  } sources`,
);

// ---------------------------------------------------------------- Collect State
const collected: { source: SourceId; job: RawJob }[] = [];
const perSource = new Map<SourceId, number>();
interface DetailedError {
  url: string;
  error: string;
  source: SourceId;
  timestamp: string;
}
const errors: Record<string, DetailedError[]> = {};

function handle(label: string, ctx: Ctx): Req[] {
  const source = sourceOfLabel(label);
  const fn = SOURCES[source]?.handle[label];
  if (!fn) {
    log.warning(`No handler registered for label: "${label}" (source: ${source})`);
    return [];
  }

  const { jobs, next = [] } = fn(ctx);
  const have = perSource.get(source) ?? 0;
  const room = Math.max(0, q.maxResultsPerSource - have);
  const valid = jobs.filter((j) => j && j.title && j.title.trim().length > 0).slice(0, room);

  for (const job of valid) {
    collected.push({ source, job });
  }

  const newTotal = have + valid.length;
  perSource.set(source, newTotal);
  log.info(`[${source}] +${valid.length} (total: ${newTotal}/${q.maxResultsPerSource}) from ${label}`);

  // Stop requesting further list pagination once source quota is filled, but keep fetching detail pages
  if (newTotal >= q.maxResultsPerSource) {
    return next.filter((n) => n.label.endsWith(":detail") || n.label.endsWith(":job") || n.label.endsWith(":items"));
  }
  return next;
}

const toCrawlee = (r: Req) => ({
  url: r.url,
  label: r.label,
  headers: (input.scrapling || input.stealthHeaders) ? getStealthHeaders(r.headers) : r.headers,
  uniqueKey: r.uniqueKey ?? `${r.label}:${r.url}`,
  userData: { ...r.userData, label: r.label },
});

const recordFailure = (source: SourceId, url: string, msg: string) => {
  const list = (errors[source] ??= []);
  list.push({
    source,
    url,
    error: msg.slice(0, 300),
    timestamp: new Date().toISOString(),
  });
};

// Check if an HTTP response contains anti-bot / challenge HTML (Cloudflare, Turnstile, PerimeterX, etc.)
function isChallengeHtml(body: string): boolean {
  if (!body || body.length < 50) return false;
  return /just a moment|attention required|cf-mitigated|challenge-running|turnstile|access denied|security check|verify you are human|bot detection|datadome/i.test(
    body,
  );
}

// ---------------------------------------------------------------- Proxies & Queues
const httpProxy: ProxyConfiguration | undefined = input.proxyConfiguration
  ? await Actor.createProxyConfiguration(input.proxyConfiguration as never)
  : undefined;

const browserProxy: ProxyConfiguration | undefined = await Actor.createProxyConfiguration(
  (input.browserProxyConfiguration ??
    (Actor.isAtHome() ? { groups: ["RESIDENTIAL"], countryCode: q.country } : undefined)) as never,
);

const httpQueue = await RequestQueue.open("jobhound-http-queue");
const browserQueue = await RequestQueue.open("jobhound-browser-queue");

// ---------------------------------------------------------------- HTTP Crawler (Cheerio)
const http = new CheerioCrawler({
  requestQueue: httpQueue,
  proxyConfiguration: httpProxy,
  minConcurrency: 2,
  maxConcurrency: input.maxConcurrency,
  maxRequestRetries: input.maxRequestRetries,
  maxRequestsPerMinute: 300,
  navigationTimeoutSecs: 30,
  requestHandlerTimeoutSecs: 60,
  additionalMimeTypes: [
    "application/json",
    "application/rss+xml",
    "application/xml",
    "text/xml",
    "application/atom+xml",
    "text/json",
    "text/plain",
  ],
  useSessionPool: true,
  sessionPoolOptions: {
    maxPoolSize: 100,
    sessionOptions: { maxUsageCount: 50 },
    blockedStatusCodes: [401, 403, 429, 999],
  },
  autoscaledPoolOptions: {
    desiredConcurrencyRatio: 0.9,
    scaleUpStepRatio: 0.2,
    scaleDownStepRatio: 0.2,
  },

  async requestHandler({ request, body, json, crawler, session }) {
    const label = String(request.userData.label ?? request.label);
    const bodyStr = body ? body.toString() : "";

    // Detect soft blocks / Cloudflare challenges on HTTP tier
    if (isChallengeHtml(bodyStr)) {
      const source = sourceOfLabel(label);
      log.warning(`[${source}] Challenge detected on HTTP tier for ${request.url}. Escalating to browser queue...`);
      session?.retire();
      await browserQueue.addRequest({
        ...toCrawlee({ url: request.url, label, headers: request.headers, userData: request.userData }),
        uniqueKey: `b:${request.url}`,
      });
      return;
    }

    const next = handle(label, {
      url: request.loadedUrl ?? request.url,
      body: bodyStr,
      json,
      userData: request.userData,
      q,
      input,
    });

    const nextHttp = next.filter((n) => tierOf(n.label) === "http");
    const nextBrowser = next.filter((n) => tierOf(n.label) === "browser");

    if (nextHttp.length) await crawler.addRequests(nextHttp.map(toCrawlee));
    if (nextBrowser.length) await browserQueue.addRequests(nextBrowser.map(toCrawlee));
  },

  async failedRequestHandler({ request }, err) {
    const label = String(request.userData.label ?? request.label);
    const source = sourceOfLabel(label);
    recordFailure(source, request.url, err.message);

    // Escalate failed HTTP requests from protected sites to the browser tier with residential proxy
    if (label.startsWith("wellfound:") || label.startsWith("linkedin:") || label.startsWith("builtin:")) {
      log.info(`[${source}] Retrying exhausted HTTP request in browser tier: ${request.url}`);
      await browserQueue.addRequest({
        ...toCrawlee({ url: request.url, label, headers: request.headers, userData: request.userData }),
        uniqueKey: `b:${request.url}`,
      });
    }
  },
});

// ---------------------------------------------------------------- Browser Crawler (Playwright)
const TRACKING_URL_PATTERNS = [
  /google-analytics\.com/i,
  /googletagmanager\.com/i,
  /hotjar\.com/i,
  /segment\.(io|com)/i,
  /clarity\.ms/i,
  /doubleclick\.net/i,
  /facebook\.net/i,
];

const browser = new PlaywrightCrawler({
  requestQueue: browserQueue,
  proxyConfiguration: browserProxy,
  minConcurrency: 1,
  maxConcurrency: input.browserMaxConcurrency,
  maxRequestRetries: input.maxRequestRetries,
  navigationTimeoutSecs: 90,
  requestHandlerTimeoutSecs: 180,
  useSessionPool: true,
  persistCookiesPerSession: true,
  sessionPoolOptions: {
    maxPoolSize: 25,
    sessionOptions: { maxUsageCount: 20 },
    blockedStatusCodes: [401, 403, 429],
  },
  browserPoolOptions: {
    useFingerprints: true,
    fingerprintOptions: {
      fingerprintGeneratorOptions: {
        browsers: ["chrome"],
        devices: ["desktop"],
        operatingSystems: ["windows", "macos", "linux"],
      },
    },
  },
  launchContext: {
    launchOptions: {
      headless: true,
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-accelerated-2d-canvas",
      ],
    },
  },

  preNavigationHooks: [
    async ({ page, request }) => {
      // Inject anti-bot evasions and fingerprint shielding
      if (input.scrapling || input.stealthHeaders) {
        await applyStealthToPage(page, input.humanEmulation);
      }

      // Block heavy images, video, fonts, and tracking scripts to maximize speed & save residential bandwidth
      await page.route(
        /\.(png|jpe?g|gif|webp|svg|woff2?|ttf|otf|mp4|webm)(\?|$)/i,
        (r) => r.abort().catch(() => {}),
      );

      for (const pattern of TRACKING_URL_PATTERNS) {
        await page.route(pattern, (r) => r.abort().catch(() => {}));
      }

      const captured: string[] = [];
      request.userData.__captured = captured;

      page.on("response", async (res) => {
        const ct = res.headers()["content-type"] ?? "";
        if (!/json/i.test(ct)) return;
        try {
          const text = await res.text();
          if (text && text.length > 2) captured.push(text);
        } catch {
          // Ignore closed responses or navigation races
        }
      });
    },
  ],

  async requestHandler({ page, request, session }) {
    const label = String(request.userData.label ?? request.label);
    const source = sourceOfLabel(label);

    const title = await page.title().catch(() => "");
    if (/just a moment|attention required|access denied|security check|verify you are human|blocked|datadome/i.test(title)) {
      log.warning(`[${source}] Cloudflare/Security challenge screen encountered ("${title}"). Awaiting auto-solve...`);
      await page.waitForTimeout(8000);
      const newTitle = await page.title().catch(() => "");
      if (/just a moment|attention required|access denied|security|verify|blocked/i.test(newTitle)) {
        session?.retire();
        throw new Error(`Challenge screen unresolved: "${newTitle}"`);
      }
    }

    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});

    // For infinite-scroll or "Load more" dynamic boards: nudge page to load initial batches
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 4000).catch(() => {});
      const more = page.locator('button:has-text("Show more jobs"), button:has-text("Load more"), button:has-text("Show more")').first();
      if (await more.isVisible().catch(() => false)) {
        await more.click().catch(() => {});
      }
      await page.waitForTimeout(1000);
    }

    const captured = (request.userData.__captured as string[] | undefined) ?? [];
    const body = (await page.content()) + captured.map((c) => `<script type="application/json">${c}</script>`).join("");

    const next = handle(label, {
      url: page.url(),
      body,
      json: null,
      userData: request.userData,
      q,
      input,
    });

    const nextHttp = next.filter((n) => tierOf(n.label) === "http");
    const nextBrowser = next.filter((n) => tierOf(n.label) === "browser");

    if (nextHttp.length) await httpQueue.addRequests(nextHttp.map(toCrawlee));
    if (nextBrowser.length) await browserQueue.addRequests(nextBrowser.map(toCrawlee));
  },

  failedRequestHandler({ request }, err) {
    const label = String(request.userData.label ?? request.label);
    recordFailure(sourceOfLabel(label), request.url, err.message);
  },
});

// Seed the queues with initial planned requests
if (httpReqs.length) await httpQueue.addRequests(httpReqs.map(toCrawlee));
if (browserReqs.length) await browserQueue.addRequests(browserReqs.map(toCrawlee));

// Execute crawlers concurrently and drain all escalated requests
log.info("Starting crawler execution...");
await Promise.all([
  httpReqs.length ? http.run() : null,
  browserReqs.length ? browser.run() : null,
]);

// Drain any late-escalated requests
while (!(await browserQueue.isFinished()) || !(await httpQueue.isFinished())) {
  if (!(await httpQueue.isFinished())) {
    log.info("Draining remaining HTTP queue requests...");
    await http.run();
  }
  if (!(await browserQueue.isFinished())) {
    log.info("Draining remaining Browser queue requests...");
    await browser.run();
  }
}

// ---------------------------------------------------------------- Deduplicate, Normalize, Score
log.info("Crawling completed. Normalizing, deduplicating, and scoring jobs...");
const now = new Date();
const scrapedAt = now.toISOString();
const byId = new Map<string, Job>();

const richness = (j: RawJob) =>
  Object.values(j).filter((v) => v != null && v !== "" && !(Array.isArray(v) && !v.length)).length;

for (const { source, job } of collected) {
  const companyNorm = normCompany(job.company);
  const titleNorm = normTitle(job.title);
  const cityNorm = normCity(job.location);
  const id = hash(`${companyNorm}|${titleNorm}|${cityNorm}`);

  const cur = byId.get(id);
  if (cur) {
    if (!cur.seenOn.includes(source)) cur.seenOn.push(source);
    if (job.url) cur.urls[source] ??= job.url;

    // Merge missing fields from cross-posted listings
    for (const [k, v] of Object.entries(job)) {
      if ((cur as never as Record<string, unknown>)[k] == null && v != null) {
        (cur as never as Record<string, unknown>)[k] = v;
      }
    }
    if (!cur.salary?.annualMin && job.salary?.annualMin) cur.salary = job.salary;
    if (job.postedAt && cur.postedAt && job.postedAt < cur.postedAt) cur.postedAt = job.postedAt;
    if (richness(job) > richness(cur as never)) cur.description = job.description ?? cur.description;
    continue;
  }

  const exp = job.description ? extractYearsOfExperience(job.description) : null;
  const detectedSeniority = job.seniority ?? detectSeniority(job.title, job.description);
  const isDirect = Boolean(
    job.isDirectAts ||
    isDirectApplyUrl(job.url ?? "") ||
    ["greenhouse", "lever", "ashby", "smartrecruiters", "workday", "jobvite", "workable", "breezy", "recruitee"].includes(source)
  );

  byId.set(id, {
    id,
    source,
    seenOn: [source],
    urls: job.url ? { [source]: job.url } : {},
    sourceJobId: job.sourceJobId ?? null,
    title: job.title.trim(),
    company: job.company?.trim() ?? null,
    location: job.location ?? null,
    workMode: job.workMode ?? null,
    employmentType: job.employmentType ?? null,
    salary: job.salary ?? null,
    postedAt: job.postedAt ?? null,
    url: job.url ?? null,
    applyUrl: job.applyUrl ?? null,
    description: job.description ?? null,
    skills: job.skills ?? [],
    seniority: detectedSeniority,
    yearsOfExperience: job.yearsOfExperience ?? exp?.min ?? null,
    isDirectAts: isDirect,
    companyStage: job.companyStage ?? null,
    companyUrl: job.companyUrl ?? null,
    companyLogo: job.companyLogo ?? null,
    applicants: job.applicants ?? null,
    score: 0,
    scoreReasons: [],
    isNew: true,
    scrapedAt,
    extra: job.extra ?? {},
  });
}

const NO_GEO = new Set<SourceId>([
  "builtin",
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workday",
  "jobvite",
  "workable",
  "breezy",
  "recruitee",
  "hackernews",
]);

const re = (s: string) => new RegExp(s, "i");
const inc = input.titleInclude.map(re);
const exc = input.titleExclude.map(re);
const badCo = new Set(input.excludeCompanies.map(normCompany));
const kws = q.keywords.toLowerCase().split(/\s+/).filter((w) => w.length > 2);

let jobs = [...byId.values()].filter((j) => {
  // 1. Title include/exclude filters
  if (inc.length && !inc.some((r) => r.test(j.title))) return false;
  if (exc.some((r) => r.test(j.title))) return false;
  if (badCo.has(normCompany(j.company))) return false;

  // 2. Work mode & Remote filters
  if (q.remoteOnly && j.workMode && j.workMode !== "remote") return false;
  if (q.workModes?.length && j.workMode && !q.workModes.includes(j.workMode)) return false;

  // 3. Seniority level filter
  if (q.seniorityLevels?.length && j.seniority) {
    if (!q.seniorityLevels.includes(j.seniority as any)) return false;
  }

  // 4. Years of experience min/max filters
  if (q.minYearsExperience != null && j.yearsOfExperience != null && j.yearsOfExperience < q.minYearsExperience) {
    return false;
  }
  if (q.maxYearsExperience != null && j.yearsOfExperience != null && j.yearsOfExperience > q.maxYearsExperience) {
    return false;
  }

  // 5. Skills include & exclude filters
  const fullText = `${j.title} ${j.description ?? ""} ${j.skills.join(" ")}`.toLowerCase();
  if (q.skillsInclude?.length) {
    const hasAll = q.skillsInclude.every((sk) => fullText.includes(sk.toLowerCase()));
    if (!hasAll) return false;
  }
  if (q.skillsExclude?.length) {
    const hasExcluded = q.skillsExclude.some((sk) => fullText.includes(sk.toLowerCase()));
    if (hasExcluded) return false;
  }

  // 6. Require equity filter
  if (q.requireEquity && !j.salary?.hasEquity) return false;

  // 7. Direct ATS Apply only filter
  if (q.directApplyOnly && !j.isDirectAts) return false;

  // 8. Max applicants filter (avoid flooded postings)
  if (q.maxApplicants != null && j.applicants != null && j.applicants > q.maxApplicants) return false;

  // 9. Full-text description include/exclude keywords
  if (q.descriptionInclude?.length) {
    const desc = (j.description ?? "").toLowerCase();
    if (!q.descriptionInclude.every((kw) => desc.includes(kw.toLowerCase()))) return false;
  }
  if (q.descriptionExclude?.length) {
    const desc = (j.description ?? "").toLowerCase();
    if (q.descriptionExclude.some((kw) => desc.includes(kw.toLowerCase()))) return false;
  }

  // 10. Geography & Location filter
  const city = q.location.split(",")[0]!.trim().toLowerCase();
  if (city && !q.remoteOnly && NO_GEO.has(j.source) && j.workMode !== "remote" && !(j.location ?? "").toLowerCase().includes(city)) {
    return false;
  }

  // 11. Salary filters
  if (q.minSalary && (j.salary?.annualMax ?? null) != null && j.salary!.annualMax! < q.minSalary) return false;
  if (q.minSalary && !input.keepUnknownSalary && j.salary?.annualMax == null) return false;

  // 12. Date posted recency filter
  const age = daysAgo(j.postedAt, now);
  if (q.postedWithinDays && age != null && age > q.postedWithinDays + 1) return false;

  return true;
});

// Scoring algorithm
for (const j of jobs) {
  const r: string[] = [];
  let s = 0;
  const t = j.title.toLowerCase();
  const hits = kws.filter((w) => t.includes(w)).length;

  if (kws.length) {
    const p = Math.round((hits / kws.length) * 40);
    s += p;
    if (p > 0) r.push(`title matches ${hits}/${kws.length} keywords`);
  } else {
    s += 20;
  }

  if (j.salary?.annualMax) {
    s += 20;
    r.push("salary listed");
    if (q.minSalary && j.salary.annualMin && j.salary.annualMin >= q.minSalary) {
      s += 5;
      r.push("salary ≥ target");
    }
  }

  const age = daysAgo(j.postedAt, now);
  if (age != null) {
    const p = Math.max(0, Math.round(20 - age));
    s += p;
    if (age <= 3) r.push("fresh (≤3d)");
  }

  if (j.workMode === "remote") {
    s += 5;
    r.push("remote");
  }

  if (j.seenOn.length > 1) {
    s += 10;
    r.push(`cross-posted on ${j.seenOn.length} boards`);
  }

  j.score = Math.min(100, s);
  j.scoreReasons = r;
}

// Incremental mode: state tracking via KeyValueStore
const state = await Actor.openKeyValueStore("jobhound-state");
const seenKey = `seen-${input.stateKey}`;
const seen = new Set((await state.getValue<string[]>(seenKey)) ?? []);

for (const j of jobs) {
  j.isNew = !seen.has(j.id);
}

if (input.onlyNew) {
  jobs = jobs.filter((j) => j.isNew);
}

await state.setValue(
  seenKey,
  [...new Set([...seen, ...jobs.map((j) => j.id)])].slice(-50000),
);

// Sort highest scored first, tiebreak by newest date
jobs.sort((a, b) => b.score - a.score || (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));

// Push dataset in batches of 500 for optimal Apify storage throughput
for (let i = 0; i < jobs.length; i += 500) {
  await Actor.pushData(jobs.slice(i, i + 500));
}

const summary = {
  query: q,
  totalRaw: collected.length,
  totalUnique: byId.size,
  totalOutput: jobs.length,
  crossPosted: jobs.filter((j) => j.seenOn.length > 1).length,
  perSource: Object.fromEntries(perSource),
  errors: Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.map((e) => `${e.url} → ${e.error}`)])),
  errorDetails: errors,
  finishedAt: new Date().toISOString(),
};

await Actor.setValue("SUMMARY", summary);
await Actor.setValue("OUTPUT", jobs.slice(0, 50));

// Custom file export (JSON / JSONL / CSV)
if (input.outputPath) {
  try {
    const exportedPath = await exportToFile(jobs, input.outputPath, input.outputFormat);
    log.info(`[Export] Saved ${jobs.length} jobs to: ${exportedPath} (${input.outputFormat})`);
  } catch (err: any) {
    log.error(`[Export] Failed to export to ${input.outputPath}: ${err.message}`);
  }
}

// Broadcast to external webhook endpoint if provided
if (input.webhookUrl) {
  log.info(`[Webhook] Streaming results to ${input.webhookUrl}...`);
  const result = await sendWebhook(input.webhookUrl, { summary, jobs });
  if (result.success) {
    log.info(`[Webhook] Successfully delivered payload (HTTP ${result.status})`);
  } else {
    log.warning(`[Webhook] Delivery failed: ${result.error}`);
  }
}

log.info(
  `Done! Successfully exported ${jobs.length} jobs (${collected.length} raw collected, ${summary.crossPosted} cross-posted). Sources: ${JSON.stringify(summary.perSource)}`,
);

if (Object.keys(errors).length) {
  log.warning(
    `Errors encountered across sources: ${JSON.stringify(
      Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.length])),
    )}`,
  );
}

await Actor.exit();
