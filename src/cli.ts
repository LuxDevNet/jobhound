#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES, sourceOfLabel } from "./sources.ts";
import { SOURCE_IDS, type Job } from "./model.ts";
import { hash, normCity, normCompany, normTitle } from "./lib/text.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (key.includes("=")) {
        const [k, v] = key.split("=", 2);
        flags[k!] = v!;
      } else if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
        flags[key] = args[i + 1]!;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      flags[key] = true;
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

function printHelp() {
  console.log(`
Jobhound CLI — Multi-board job scraper & pipeline

USAGE:
  jobhound run [preset] [options]       Run scraper locally or on a distributed VM
  jobhound sources                      List all supported job boards and ATS engines
  jobhound merge <paths...>             Merge and deduplicate outputs from distributed shards
  jobhound help                         Show this help message

OPTIONS:
  -k, --keywords <str>         Job keywords / title (e.g. "senior backend engineer")
  -l, --location <str>         Location filter (e.g. "San Diego, CA")
  --remote                     Filter for remote jobs only
  --salary <num>               Minimum annual salary filter in USD
  --days <num>                 Posted within N days (1, 3, 7, 14, 30)
  --sources <list>             Comma-separated list of boards to scrape
  --boards <list>              Comma-separated list of ATS boards (e.g. "greenhouse:stripe,lever:palantir")

DISTRIBUTED & SHARDING OPTIONS (for 2-50 VMs / containers):
  --shards <total>             Total number of worker nodes / shards (e.g. 5 or 15)
  --shard <index>              Zero-based shard index for this worker (e.g. 0..4)
  --output <path>              Custom output directory or JSON file path
  --format <json|jsonl|csv>    Output export format (default: json)

EXAMPLES:
  # Run a search across all boards locally:
  npx tsx src/cli.ts run -k "Staff Engineer" -l "Remote" --remote

  # Run Worker 1 of 5 in a distributed VM setup:
  npx tsx src/cli.ts run -k "Frontend" --shards 5 --shard 0

  # Merge outputs from all VM shards into a single deduped master dataset:
  npx tsx src/cli.ts merge storage/datasets/shard-*/ > master-jobs.json
`);
}

async function runScraper(flags: Record<string, string | boolean>, preset?: string) {
  const inputConfig: Record<string, unknown> = {};

  if (flags.keywords || flags.k) inputConfig.keywords = String(flags.keywords || flags.k);
  if (flags.location || flags.l) inputConfig.location = String(flags.location || flags.l);
  if (flags.remote) inputConfig.remoteOnly = true;
  if (flags.salary) inputConfig.minSalary = Number(flags.salary);
  if (flags.days) inputConfig.postedWithinDays = Number(flags.days);
  if (flags.shards) inputConfig.shardTotal = Number(flags.shards);
  if (flags.shard) inputConfig.shardIndex = Number(flags.shard);

  if (flags.sources) {
    inputConfig.sources = String(flags.sources).split(",").map((s) => s.trim());
  }
  if (flags.boards) {
    inputConfig.companyBoards = String(flags.boards).split(",").map((b) => b.trim());
  }

  // Ensure default storage directory exists
  const defaultDir = path.resolve(process.cwd(), "storage/key_value_stores/default");
  await fs.mkdir(defaultDir, { recursive: true });
  await fs.writeFile(
    path.join(defaultDir, "INPUT.json"),
    JSON.stringify(inputConfig, null, 2),
    "utf-8"
  );

  console.log(`[Jobhound] Configuration written to storage/key_value_stores/default/INPUT.json`);
  if (inputConfig.shardTotal && Number(inputConfig.shardTotal) > 1) {
    console.log(`[Jobhound] Running in Distributed Shard Mode (Shard ${(Number(inputConfig.shardIndex) || 0) + 1}/${inputConfig.shardTotal})`);
  }

  // Dynamically import and run main
  await import("./main.ts");
}

function listSources() {
  console.log("\nSupported Job Boards & ATS Sources:\n");
  console.log(
    "ID".padEnd(20) +
    "TIER".padEnd(12) +
    "FEATURES"
  );
  console.log("-".repeat(60));

  for (const id of SOURCE_IDS) {
    const src = SOURCES[id];
    const tier = src?.tier ?? (id === "generic" ? "browser" : "http");
    const features = src?.fromUrl ? "Direct URL + Search" : "Search API / Crawl";
    console.log(
      id.padEnd(20) +
      tier.toUpperCase().padEnd(12) +
      features
    );
  }
  console.log("\nTotal available sources:", SOURCE_IDS.length);
}

async function mergeDatasets(paths: string[], flags: Record<string, string | boolean>) {
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

  // Deduplicate by cross-board fingerprint hash
  const dedupedMap = new Map<string, Job>();
  for (const j of allJobs) {
    const fp = j.id || `${normCompany(j.company)}:${normTitle(j.title)}:${normCity(j.location)}`;
    if (!dedupedMap.has(fp)) {
      dedupedMap.set(fp, j);
    } else {
      const existing = dedupedMap.get(fp)!;
      // Merge seenOn and URLs
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
