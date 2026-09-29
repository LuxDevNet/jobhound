import { z } from "zod";
import {
  EMPLOYMENT_TYPES,
  SENIORITY_LEVELS,
  SOURCE_IDS,
  WORK_MODES,
  type SearchQuery,
} from "./model.ts";

const PostedWithin = z
  .union([z.literal(""), z.coerce.number()])
  .transform((v) => (v === "" || v === 0 ? null : ([1, 3, 7, 14, 30].find((b) => b >= v) ?? 30)) as SearchQuery["postedWithinDays"]);

/** Mirrors .actor/input_schema.json. Zod gives us defaults + a single typed object. */
export const InputSchema = z.object({
  // Core Search Filters
  keywords: z.string().default(""),
  location: z.string().default(""),
  country: z.string().length(2).default("US"),
  radiusMiles: z.coerce.number().int().min(0).nullable().default(null),
  postedWithinDays: PostedWithin.nullable().default(null),
  remoteOnly: z.boolean().default(false),
  workModes: z.array(z.enum(WORK_MODES)).default([]),
  minSalary: z.coerce.number().int().min(0).nullable().default(null),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).default([]),

  // 10 High-Quality Advanced Precision Filters
  seniorityLevels: z.array(z.enum(SENIORITY_LEVELS)).default([]),
  minYearsExperience: z.coerce.number().int().min(0).nullable().default(null),
  maxYearsExperience: z.coerce.number().int().min(0).nullable().default(null),
  skillsInclude: z.array(z.string()).default([]),
  skillsExclude: z.array(z.string()).default([]),
  requireEquity: z.boolean().default(false),
  directApplyOnly: z.boolean().default(false),
  maxApplicants: z.coerce.number().int().min(0).nullable().default(null),
  descriptionInclude: z.array(z.string()).default([]),
  descriptionExclude: z.array(z.string()).default([]),

  // Source & Board Controls
  sources: z
    .array(z.enum(SOURCE_IDS))
    .default([
      "linkedin",
      "indeed",
      "glassdoor",
      "wellfound",
      "upwork",
      "ziprecruiter",
      "dice",
      "simplyhired",
      "builtin",
      "remoteok",
      "himalayas",
    ]),
  maxResultsPerSource: z.coerce.number().int().min(1).max(5000).default(100),

  /** Paste any job-board search URL. The board is auto-detected and its generated search is replaced. */
  startUrls: z
    .array(z.union([z.string(), z.object({ url: z.string() }).passthrough()]))
    .default([])
    .transform((a) => a.map((x) => (typeof x === "string" ? x : x.url)).filter(Boolean)),

  /** "greenhouse:stripe", "lever:palantir", "ashby:ramp", or the board URL itself. */
  companyBoards: z.array(z.string()).default([]),

  fetchDetails: z.boolean().default(true),

  titleInclude: z.array(z.string()).default([]),
  titleExclude: z.array(z.string()).default([]),
  excludeCompanies: z.array(z.string()).default([]),
  keepUnknownSalary: z.boolean().default(true),

  onlyNew: z.boolean().default(false),
  stateKey: z.string().default("default"),

  proxyConfiguration: z.record(z.string(), z.unknown()).optional(),
  browserProxyConfiguration: z.record(z.string(), z.unknown()).optional(),
  maxConcurrency: z.coerce.number().int().min(1).max(50).default(8),
  browserMaxConcurrency: z.coerce.number().int().min(1).max(20).default(3),
  maxRequestRetries: z.coerce.number().int().min(0).max(20).default(6),

  /** Distributed run sharding across multiple VMs/processes. */
  shardTotal: z.coerce.number().int().min(1).default(1),
  shardIndex: z.coerce.number().int().min(0).default(0),

  /** Scrapling & stealth evasion engine settings. */
  scrapling: z.boolean().default(false),
  stealthHeaders: z.boolean().default(true),
  humanEmulation: z.boolean().default(false),

  /** Override base URLs per source or route through proxy scrapers (e.g. ScrapingBee/Scrapling endpoints). */
  baseUrls: z.record(z.string(), z.string()).default({}),

  /** Output endpoints: Webhooks, custom file exports, formats. */
  webhookUrl: z.string().nullable().optional(),
  outputPath: z.string().nullable().optional(),
  outputFormat: z.enum(["json", "jsonl", "csv"]).default("json"),

  /** Dice's public search key (embedded in dice.com's frontend). Override if it rotates. */
  diceApiKey: z.string().default("1YAt0R9wBg4WfsF9VB2778F5CHLAPMVW3WAZcKd8"),
  debug: z.boolean().default(false),
});

export type Input = z.infer<typeof InputSchema>;

export function toQuery(i: Input): SearchQuery {
  return {
    keywords: i.keywords.trim(),
    location: i.location.trim(),
    country: i.country.toUpperCase(),
    radiusMiles: i.radiusMiles,
    postedWithinDays: i.postedWithinDays,
    remoteOnly: i.remoteOnly,
    minSalary: i.minSalary,
    employmentTypes: i.employmentTypes,
    maxResultsPerSource: i.maxResultsPerSource,

    seniorityLevels: i.seniorityLevels,
    minYearsExperience: i.minYearsExperience,
    maxYearsExperience: i.maxYearsExperience,
    skillsInclude: i.skillsInclude,
    skillsExclude: i.skillsExclude,
    requireEquity: i.requireEquity,
    directApplyOnly: i.directApplyOnly,
    maxApplicants: i.maxApplicants,
    descriptionInclude: i.descriptionInclude,
    descriptionExclude: i.descriptionExclude,
    workModes: i.workModes,
  };
}
