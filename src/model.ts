export const SOURCE_IDS = [
  // Mainstream boards
  "linkedin",
  "indeed",
  "glassdoor",
  "wellfound",
  "upwork",
  "ziprecruiter",
  "dice",
  "simplyhired",
  "monster",
  "builtin",
  // Remote-first boards with public feeds
  "remoteok",
  "remotive",
  "himalayas",
  "weworkremotely",
  "hackernews",
  // Direct from company applicant-tracking systems (posted here first)
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workday",
  "jobvite",
  "workable",
  "breezy",
  "recruitee",
  // Any other URL: JSON-LD / embedded-JSON auto-extraction
  "generic",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const WORK_MODES = ["remote", "hybrid", "onsite"] as const;
export type WorkMode = (typeof WORK_MODES)[number];

export const SENIORITY_LEVELS = [
  "intern",
  "entry",
  "mid",
  "senior",
  "lead",
  "staff",
  "principal",
  "director",
  "executive",
] as const;
export type SeniorityLevel = (typeof SENIORITY_LEVELS)[number];

export type SalaryPeriod = "hour" | "day" | "week" | "month" | "year" | "fixed";

export interface Salary {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: SalaryPeriod | null;
  /** Normalized to yearly so every board is comparable. */
  annualMin: number | null;
  annualMax: number | null;
  raw: string | null;
  hasEquity?: boolean;
}

/** What a source handler extracts. Everything except title is optional. */
export interface RawJob {
  sourceJobId?: string | null;
  title: string;
  company?: string | null;
  location?: string | null;
  workMode?: WorkMode | null;
  employmentType?: EmploymentType | null;
  salary?: Salary | null;
  postedAt?: string | null;
  url?: string | null;
  applyUrl?: string | null;
  description?: string | null;
  skills?: string[];
  seniority?: SeniorityLevel | string | null;
  yearsOfExperience?: number | null;
  isDirectAts?: boolean;
  companyStage?: string | null;
  companyUrl?: string | null;
  companyLogo?: string | null;
  applicants?: number | null;
  /** Anything extra worth keeping, per source. */
  extra?: Record<string, unknown>;
}

/** Final dataset row. */
export interface Job extends Required<Omit<RawJob, "extra">> {
  /** Cross-board fingerprint: company + title + city. */
  id: string;
  source: SourceId;
  /** Every board this same job showed up on, after dedupe. */
  seenOn: SourceId[];
  /** All listing URLs for this job, one per board. */
  urls: Partial<Record<SourceId, string>>;
  score: number;
  scoreReasons: string[];
  isNew: boolean;
  scrapedAt: string;
  extra: Record<string, unknown>;
}

/** Unified search: expressed once, translated per board. */
export interface SearchQuery {
  keywords: string;
  location: string;
  country: string;
  radiusMiles: number | null;
  postedWithinDays: 1 | 3 | 7 | 14 | 30 | null;
  remoteOnly: boolean;
  minSalary: number | null;
  employmentTypes: EmploymentType[];
  maxResultsPerSource: number;

  // Advanced High-Value Filters
  seniorityLevels?: SeniorityLevel[];
  minYearsExperience?: number | null;
  maxYearsExperience?: number | null;
  skillsInclude?: string[];
  skillsExclude?: string[];
  requireEquity?: boolean;
  directApplyOnly?: boolean;
  maxApplicants?: number | null;
  descriptionInclude?: string[];
  descriptionExclude?: string[];
  workModes?: WorkMode[];
}
