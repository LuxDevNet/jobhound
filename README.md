# Jobhound — your own Apify job scraper (TypeScript + Crawlee)

One query → 18 job boards → one normalized, deduped, scored dataset. No third-party actors, no per-result fees: you run your own code.

## Sources and how each one is scraped

| Board | Method | Tier | Tested live |
|---|---|---|---|
| LinkedIn | Public guest API (`jobs-guest/...`) + detail pages (description, seniority, salary, applicants, offsite apply URL) | HTTP | ✅ |
| Dice | Dice's own search API (100/page, native radius/date/remote/type filters) | HTTP | ✅ |
| Wellfound | Server-rendered Apollo cache in `__NEXT_DATA__` (salary + equity + company) → auto-falls back to browser if challenged | HTTP | ✅ |
| BuiltIn | List cards + JSON-LD `JobPosting` on detail pages | HTTP | ✅ |
| RemoteOK / Remotive / Himalayas | Public JSON APIs | HTTP | ✅ |
| We Work Remotely | RSS | HTTP | ✅ |
| HN "Who is hiring" | Latest thread via Algolia API, parsed `Company \| Role \| Location \| $` | HTTP | ✅ |
| Greenhouse / Lever / Ashby | Company ATS APIs (jobs appear here before LinkedIn/Indeed) | HTTP | ✅ |
| Indeed | Playwright → `window.mosaic.providerData["mosaic-provider-jobcards"]` | Browser | needs residential proxy |
| Glassdoor, Upwork, ZipRecruiter, Monster | Playwright + captured GraphQL/XHR JSON + embedded JSON → heuristic job finder | Browser | needs residential proxy |
| SimplyHired | Playwright → `__NEXT_DATA__.props.pageProps.jobs` | Browser | needs residential proxy |
| Any other URL | JSON-LD / embedded JSON auto-extraction | Browser | — |

Protected boards (Cloudflare/DataDome) returned 403 from a datacenter IP during testing. On Apify they run through the RESIDENTIAL proxy group by default, with fingerprinted browsers, session rotation, and challenge detection.

## Run on Apify
```bash
npm i -g apify-cli
apify login
apify push          # builds the Docker image and creates the actor
```
Then run it from the Console, or with `apify call jobhound -i input.json`.

## Run locally
```bash
npm install && npx playwright install chromium
# edit storage/key_value_stores/default/INPUT.json
npx tsx src/main.ts
# results: storage/datasets/default/, summary: storage/key_value_stores/default/SUMMARY.json
```

## Input highlights
- `keywords`, `location`, `radiusMiles`, `postedWithinDays`, `remoteOnly`, `minSalary`, `employmentTypes`: set once and translated into each board's native filters.
- `startUrls`: paste any board's search URL from your browser, e.g. your Indeed `San Diego / 50mi / $120k+ / FT|PT|Contract` URL. Jobhound detects the board, strips tracking params, and uses that URL instead of the generated search.
- `companyBoards`: `greenhouse:stripe`, `lever:palantir`, `ashby:ramp` (or paste the board URL).
- `onlyNew` + `stateKey`: remembers which jobs you've already seen. Put it on an Apify schedule for daily alerts.
- `titleInclude` / `titleExclude` (regex) and `excludeCompanies`.

## Output (one row per unique job)
`id` (cross-board fingerprint), `title`, `company`, `location`, `workMode`, `employmentType`, `salary{min,max,period,currency,annualMin,annualMax,raw}`, `postedAt` (ISO), `url`, `applyUrl`, `description`, `skills`, `seniority`, `applicants`, `seenOn[]`, `urls{board:url}`, `score` (0–100) + `scoreReasons`, `isNew`.

Salaries are annualized: hourly ×2080, monthly ×12, and so on. Relative dates ("3 days ago", "30+ days") are converted to ISO. Jobs are deduped by company + title + city across boards and merged to fill gaps from each copy.

## Layout
```
.actor/            actor.json, input_schema.json, Dockerfile
src/main.ts        plan → HTTP + browser crawlers in parallel → merge/dedupe/filter/score → dataset
src/sources.ts     one adapter per board (plan, fromUrl, handlers)
src/extractors.ts  universal JSON-LD / embedded-JSON / network-JSON job finder
src/lib/           salary, dates, text normalization, URL cleaning + Indeed URL builder
```

## Adding a board
Add an id in `src/model.ts` and a `Source` in `src/sources.ts` with `plan()` and a handler. Set `tier: "browser"` if the site uses anti-bot protection.

Note: respect each site's terms of service and rate limits. LinkedIn guest endpoints return 429 errors at high volume; add a proxy if you plan to pull thousands of results.
