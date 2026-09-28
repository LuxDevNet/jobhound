import { describe, it, expect } from "vitest";
import {
  SOURCE_IDS,
  EMPLOYMENT_TYPES,
  WORK_MODES,
  type SourceId,
  type EmploymentType,
  type WorkMode,
  type Salary,
  type RawJob,
  type Job,
  type SearchQuery,
} from "../src/model.ts";

describe("model.ts", () => {
  it("defines all expected SOURCE_IDS", () => {
    expect(SOURCE_IDS).toContain("linkedin");
    expect(SOURCE_IDS).toContain("indeed");
    expect(SOURCE_IDS).toContain("glassdoor");
    expect(SOURCE_IDS).toContain("wellfound");
    expect(SOURCE_IDS).toContain("upwork");
    expect(SOURCE_IDS).toContain("ziprecruiter");
    expect(SOURCE_IDS).toContain("dice");
    expect(SOURCE_IDS).toContain("simplyhired");
    expect(SOURCE_IDS).toContain("monster");
    expect(SOURCE_IDS).toContain("builtin");
    expect(SOURCE_IDS).toContain("remoteok");
    expect(SOURCE_IDS).toContain("remotive");
    expect(SOURCE_IDS).toContain("himalayas");
    expect(SOURCE_IDS).toContain("weworkremotely");
    expect(SOURCE_IDS).toContain("hackernews");
    expect(SOURCE_IDS).toContain("greenhouse");
    expect(SOURCE_IDS).toContain("lever");
    expect(SOURCE_IDS).toContain("ashby");
    expect(SOURCE_IDS).toContain("smartrecruiters");
    expect(SOURCE_IDS).toContain("workday");
    expect(SOURCE_IDS).toContain("jobvite");
    expect(SOURCE_IDS).toContain("workable");
    expect(SOURCE_IDS).toContain("breezy");
    expect(SOURCE_IDS).toContain("recruitee");
    expect(SOURCE_IDS).toContain("generic");
    expect(SOURCE_IDS.length).toBe(25);
  });

  it("defines all expected EMPLOYMENT_TYPES", () => {
    const expected: EmploymentType[] = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"];
    expect(EMPLOYMENT_TYPES).toEqual(expected);
  });

  it("defines all expected WORK_MODES", () => {
    const expected: WorkMode[] = ["remote", "hybrid", "onsite"];
    expect(WORK_MODES).toEqual(expected);
  });

  it("validates Salary type structure", () => {
    const salary: Salary = {
      min: 100000,
      max: 150000,
      currency: "USD",
      period: "year",
      annualMin: 100000,
      annualMax: 150000,
      raw: "$100k - $150k",
    };
    expect(salary.min).toBe(100000);
    expect(salary.annualMax).toBe(150000);
  });

  it("validates RawJob type structure with minimal and complete fields", () => {
    const minRaw: RawJob = {
      title: "Software Engineer",
    };
    expect(minRaw.title).toBe("Software Engineer");

    const fullRaw: RawJob = {
      sourceJobId: "job-123",
      title: "Staff Engineer",
      company: "Acme Corp",
      location: "San Diego, CA",
      workMode: "hybrid",
      employmentType: "full_time",
      salary: {
        min: 160000,
        max: 200000,
        currency: "USD",
        period: "year",
        annualMin: 160000,
        annualMax: 200000,
        raw: "$160k - $200k/yr",
      },
      postedAt: "2026-06-01T00:00:00.000Z",
      url: "https://example.com/job/123",
      applyUrl: "https://example.com/apply/123",
      description: "Build distributed systems.",
      skills: ["TypeScript", "Node.js", "Docker"],
      seniority: "Staff",
      companyUrl: "https://example.com",
      companyLogo: "https://example.com/logo.png",
      applicants: 12,
      extra: { tag: "featured" },
    };
    expect(fullRaw.company).toBe("Acme Corp");
    expect(fullRaw.skills).toHaveLength(3);
  });

  it("validates Job type structure", () => {
    const job: Job = {
      id: "acme-staffengineer-sandiego",
      source: "greenhouse",
      seenOn: ["greenhouse", "linkedin"],
      urls: { greenhouse: "https://boards.greenhouse.io/acme/jobs/123" },
      score: 95,
      scoreReasons: ["Direct ATS", "Salary in range"],
      isNew: true,
      scrapedAt: "2026-06-15T12:00:00.000Z",
      sourceJobId: "123",
      title: "Staff Engineer",
      company: "Acme",
      location: "San Diego, CA",
      workMode: "remote",
      employmentType: "full_time",
      salary: null,
      postedAt: "2026-06-14T00:00:00.000Z",
      url: "https://boards.greenhouse.io/acme/jobs/123",
      applyUrl: null,
      description: "Job details here",
      skills: ["TypeScript"],
      seniority: "Staff",
      companyUrl: null,
      companyLogo: null,
      applicants: null,
      extra: {},
    };

    expect(job.id).toBe("acme-staffengineer-sandiego");
    expect(job.seenOn).toEqual(["greenhouse", "linkedin"]);
    expect(job.score).toBe(95);
  });

  it("validates SearchQuery structure", () => {
    const query: SearchQuery = {
      keywords: "TypeScript Engineer",
      location: "San Diego",
      country: "US",
      radiusMiles: 25,
      postedWithinDays: 7,
      remoteOnly: true,
      minSalary: 120000,
      employmentTypes: ["full_time", "contract"],
      maxResultsPerSource: 50,
    };

    expect(query.keywords).toBe("TypeScript Engineer");
    expect(query.employmentTypes).toHaveLength(2);
    expect(query.postedWithinDays).toBe(7);
  });
});
