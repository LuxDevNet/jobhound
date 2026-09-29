#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { SOURCES } from "./sources.ts";
import { SOURCE_IDS, type Job } from "./model.ts";
import { loadPreset, listAllPresets, savePreset } from "./presets.ts";
import { hash, normCity, normCompany, normTitle } from "./lib/text.ts";

function parseArgs(args: string[]) {
  const flags: Record<string, any> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        flags[k!] = v!;
      } else if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        // Multi-value flags support like --base-url or arrays
        if (flags[key]) {
          if (Array.isArray(flags[key])) flags[key].push(args[i + 1]!);
          else flags[key] = [flags[key], args[i + 1]!];
        } else {
          flags[key] = args[i + 1]!;
        }
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        flags[key] = args[i + 1]!;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

function printHelp() {
  console.log(`
Jobhound CLI — Multi-board job scraper, pipeline & presets engine

USAGE:
  jobhound run [preset] [options]       Run scraper using CLI flags or a named preset
  jobhound presets                      List all available search presets
  jobhound preset save <name> [options] Save search parameters as a named preset in searches/
  jobhound sources                      List all supported job boards and ATS engines
  jobhound merge <paths...>             Merge and deduplicate outputs from distributed VM shards
  jobhound help                         Show this help message

SEARCH OPTIONS:
  -k, --keywords <str>         Job keywords / title (e.g. "Staff Engineer")
  -l, --location <str>         Location filter (e.g. "San Diego, CA")
  --country <iso-2>            Two-letter country code (default: US)
  --radius <miles>             Search radius in miles (default: 50)
  --remote                     Filter for remote jobs only
  --salary <num>               Minimum annual salary in USD (e.g. 130000)
  --days <num>                 Posted within N days (1, 3, 7, 14, 30)
  --sources <list>             Comma-separated list of boards (e.g. "linkedin,indeed,dice")
  --boards <list>              Comma-separated ATS boards (e.g. "greenhouse:stripe,lever:palantir")
  --include <regex>            Title must match regex
  --exclude <regex>            Title must NOT match regex
  --exclude-companies <list>   Comma-separated company names to exclude

SCRAPLING & STEALTH OPTIONS:
  --scrapling                  Enable Scrapling anti-bot evasion & fingerprint shielding
  --human                      Enable human-like mouse movements and scroll simulation
  --proxy <url>                Custom HTTP/SOCKS5 proxy URL
  --residential                Use residential proxy group on Apify

CUSTOM BASE URLS & PROXY ROUTING:
  --base-url <source=url>      Override base URL or route through proxy scrapers
                               Example: --base-url indeed=https://ca.indeed.com
                               Example: --base-url dice=https://proxy.scraper.com/api

OUTPUT ENDPOINTS & FORMATTING:
  -o, --output <path>          Save results to custom file (e.g. ./jobs.json or ./jobs.csv)
  -f, --format <json|jsonl|csv> Output format (default: json)
  --webhook <url>              Stream/POST final results payload to an external HTTP webhook

PERFORMANCE & DISTRIBUTED SHARDING:
  --concurrency <num>          HTTP concurrency (default: 8)
  --browser-concurrency <num>  Headless browser concurrency (default: 3)
  --retries <num>              Max retries per failed request (default: 6)
  --shards <total>             Total number of worker nodes (e.g. 5 or 15)
  --shard <index>              Zero-based shard index for this worker (e.g. 0..4)
  --debug                      Enable verbose debug logging

EXAMPLES:
  # Run a named preset:
  npx tsx src/cli.ts run san-diego-120k

  # Run with Scrapling mode and export to CSV:
  npx tsx src/cli.ts run -k "Machine Learning" --remote --scrapling -o ./ml_jobs.csv -f csv

  # Run with Webhook output streaming:
  npx tsx src/cli.ts run -k "React" --webhook https://api.mycompany.com/webhooks/jobs

  # Run Worker 1 of 5 on a distributed VM cluster:
  npx tsx src/cli.ts run san-diego-120k --shards 5 --shard 0
`);
}

async function runScraper(flags: Record<string, any>, presetName?: string) {
  let inputConfig: Record<string, any> = {};

  // 1. Check if running a preset
  const targetPreset = presetName || (typeof flags.preset === "string" ? flags.preset : undefined);
  if (targetPreset) {
    const loaded = await loadPreset(targetPreset);
    if (loaded) {
      console.log(`[Jobhound] Loaded preset: "${loaded.name}" — ${loaded.description}`);
      inputConfig = { ...loaded.config };
    } else {
      console.warn(`[Jobhound] Warning: Preset "${targetPreset}" not found. Running with flags.`);
    }
  }

  // 2. Override with CLI flags
  if (flags.keywords || flags.k) inputConfig.keywords = String(flags.keywords || flags.k);
  if (flags.location || flags.l) inputConfig.location = String(flags.location || flags.l);
  if (flags.country) inputConfig.country = String(flags.country).toUpperCase();
  if (flags.radius) inputConfig.radiusMiles = Number(flags.radius);
  if (flags.remote) inputConfig.remoteOnly = true;
  if (flags.salary) inputConfig.minSalary = Number(flags.salary);
  if (flags.days) inputConfig.postedWithinDays = Number(flags.days);
  if (flags.shards) inputConfig.shardTotal = Number(flags.shards);
  if (flags.shard != null) inputConfig.shardIndex = Number(flags.shard);

  if (flags.sources) {
    inputConfig.sources = String(flags.sources).split(",").map((s) => s.trim());
  }
  if (flags.boards) {
    inputConfig.companyBoards = String(flags.boards).split(",").map((b) => b.trim());
  }
  if (flags.include) {
    inputConfig.titleInclude = String(flags.include).split(",").map((s) => s.trim());
  }
  if (flags.exclude) {
    inputConfig.titleExclude = String(flags.exclude).split(",").map((s) => s.trim());
  }
  if (flags["exclude-companies"]) {
    inputConfig.excludeCompanies = String(flags["exclude-companies"]).split(",").map((s) => s.trim());
  }

  // Scrapling & Stealth
  if (flags.scrapling || flags.stealth) inputConfig.scrapling = true;
  if (flags.human) inputConfig.humanEmulation = true;

  // Base URLs overrides: e.g. --base-url indeed=https://ca.indeed.com
  if (flags["base-url"]) {
    inputConfig.baseUrls = inputConfig.baseUrls || {};
    const baseUrlsList = Array.isArray(flags["base-url"]) ? flags["base-url"] : [flags["base-url"]];
    for (const item of baseUrlsList) {
      const [src, url] = String(item).split("=", 2);
      if (src && url) {
        inputConfig.baseUrls[src.trim()] = url.trim();
      }
    }
  }

  // Output endpoints & format
  if (flags.output || flags.o) inputConfig.outputPath = String(flags.output || flags.o);
  if (flags.format || flags.f) inputConfig.outputFormat = String(flags.format || flags.f).toLowerCase();
  if (flags.webhook) inputConfig.webhookUrl = String(flags.webhook);

  // Concurrency & Retries
  if (flags.concurrency) inputConfig.maxConcurrency = Number(flags.concurrency);
  if (flags["browser-concurrency"]) inputConfig.browserMaxConcurrency = Number(flags["browser-concurrency"]);
  if (flags.retries) inputConfig.maxRequestRetries = Number(flags.retries);
  if (flags.debug) inputConfig.debug = true;

  // Ensure default storage directory exists
  const defaultDir = path.resolve(process.cwd(), "storage/key_value_stores/default");
  await fs.mkdir(defaultDir, { recursive: true });
  await fs.writeFile(
    path.join(defaultDir, "INPUT.json"),
    JSON.stringify(inputConfig, null, 2),
    "utf-8"
  );

  console.log(`[Jobhound] Configuration prepared. Starting pipeline...`);
  if (inputConfig.shardTotal && Number(inputConfig.shardTotal) > 1) {
    console.log(`[Jobhound] Distributed Mode: Shard ${(Number(inputConfig.shardIndex) || 0) + 1} of ${inputConfig.shardTotal}`);
  }
  if (inputConfig.scrapling) {
    console.log(`[Jobhound] Scrapling Mode: Active (Anti-bot evasion & fingerprint shielding enabled)`);
  }
  if (inputConfig.webhookUrl) {
    console.log(`[Jobhound] Output Webhook: ${inputConfig.webhookUrl}`);
  }
  if (inputConfig.outputPath) {
    console.log(`[Jobhound] Output File: ${inputConfig.outputPath} (${inputConfig.outputFormat || "json"})`);
  }

  // Dynamically import and run main
  await import("./main.ts");
}

async function handlePresetsCommand(subcommand?: string, name?: string, flags?: Record<string, any>) {
  if (subcommand === "save" && name) {
    const config: Record<string, any> = {};
    if (flags?.keywords || flags?.k) config.keywords = flags.keywords || flags.k;
    if (flags?.location || flags?.l) config.location = flags.location || flags.l;
    if (flags?.remote) config.remoteOnly = true;
    if (flags?.salary) config.minSalary = Number(flags.salary);
    if (flags?.days) config.postedWithinDays = Number(flags.days);
    if (flags?.sources) config.sources = String(flags.sources).split(",").map((s) => s.trim());
    if (flags?.boards) config.companyBoards = String(flags.boards).split(",").map((s) => s.trim());

    const savedPath = await savePreset(name, config, String(flags?.description || ""));
    console.log(`[Jobhound] Preset saved to: ${savedPath}`);
    return;
  }

  const all = await listAllPresets();
  console.log("\nAvailable Jobhound Presets:\n");
  console.log("NAME".padEnd(24) + "DESCRIPTION");
  console.log("-".repeat(70));
  for (const p of all) {
    console.log(p.name.padEnd(24) + p.description);
  }
  console.log("\nRun any preset with: npx tsx src/cli.ts run <preset-name>\n");
}

function listSources() {
  console.log("\nSupported Job Boards & ATS Sources:\n");
  console.log("ID".padEnd(20) + "TIER".padEnd(12) + "FEATURES");
  console.log("-".repeat(60));

  for (const id of SOURCE_IDS) {
    const src = SOURCES[id];
    const tier = src?.tier ?? (id === "generic" ? "browser" : "http");
    const features = src?.fromUrl ? "Direct URL + Search" : "Search API / Crawl";
    console.log(id.padEnd(20) + tier.toUpperCase().padEnd(12) + features);
  }
  console.log("\nTotal available sources:", SOURCE_IDS.length);
}

async function mergeDatasets(paths: string[], flags: Record<string, any>) {
  if (!paths.length) {
    console.error("Please provide directory paths or JSON file paths to merge.");
    process.exit(1);
  }

  const allJobs: Job[] = [];

  for (const p of paths) {
    const resolved = path.resolve(process.cwd(), p);
    try {
      const stats = await fs.stat(resolved);
      if (stats.isDirectory()) {
        const files = await fs.readdir(resolved);
        for (const file of files) {
          if (file.endsWith(".json")) {
            const content = await fs.readFile(path.join(resolved, file), "utf-8");
            try {
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed)) allJobs.push(...parsed);
              else if (parsed && typeof parsed === "object" && parsed.id) allJobs.push(parsed);
            } catch {}
          }
        }
      } else if (stats.isFile()) {
        const content = await fs.readFile(resolved, "utf-8");
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) allJobs.push(...parsed);
        else if (parsed && typeof parsed === "object" && parsed.id) allJobs.push(parsed);
      }
    } catch (e: any) {
      console.error(`Warning: Could not read ${resolved}:`, e.message);
    }
  }

  const dedupedMap = new Map<string, Job>();
  for (const j of allJobs) {
    const fp = j.id || `${normCompany(j.company)}:${normTitle(j.title)}:${normCity(j.location)}`;
    if (!dedupedMap.has(fp)) {
      dedupedMap.set(fp, j);
    } else {
      const existing = dedupedMap.get(fp)!;
      existing.seenOn = Array.from(new Set([...existing.seenOn, ...j.seenOn]));
      existing.urls = { ...existing.urls, ...j.urls };
    }
  }

  const merged = Array.from(dedupedMap.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  console.log(JSON.stringify(merged, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseArgs(argv);
  const command = positional[0]?.toLowerCase() || "help";

  switch (command) {
    case "run":
      await runScraper(flags, positional[1]);
      break;
    case "presets":
    case "preset":
      await handlePresetsCommand(positional[1], positional[2], flags);
      break;
    case "sources":
      listSources();
      break;
    case "merge":
      await mergeDatasets(positional.slice(1), flags);
      break;
    case "help":
    default:
      printHelp();
      break;
  }
}

main().catch((err) => {
  console.error("Jobhound Error:", err);
  process.exit(1);
});
