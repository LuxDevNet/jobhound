import { describe, it, expect } from "vitest";
import { BUILTIN_PRESETS, loadPreset, listAllPresets } from "../src/presets.ts";
import { jobsToCsv, jobsToJsonl } from "../src/lib/export.ts";
import type { Job } from "../src/model.ts";

describe("presets.ts", () => {
  it("contains valid built-in presets", () => {
    expect(BUILTIN_PRESETS["san-diego-120k"]).toBeDefined();
    expect(BUILTIN_PRESETS["remote-staff-eng"]).toBeDefined();
    expect(BUILTIN_PRESETS["ai-ml-engineer"]).toBeDefined();
    expect(BUILTIN_PRESETS["frontend-react"]).toBeDefined();
    expect(BUILTIN_PRESETS["top-tech-ats"]).toBeDefined();
  });

  it("loads built-in preset case-insensitively", async () => {
    const p = await loadPreset("SAN-DIEGO-120K");
    expect(p).not.toBeNull();
    expect(p?.config.minSalary).toBe(120000);
  });

  it("lists all presets", async () => {
    const list = await listAllPresets();
    expect(list.length).toBeGreaterThanOrEqual(5);
  });
});

describe("export.ts", () => {
  const sampleJobs: Job[] = [
    {
      id: "test1",
      source: "linkedin",
      sourceJobId: "12345",
      title: "Senior Software Engineer",
      company: "Acme Corp",
      location: "San Diego, CA",
      workMode: "remote",
      employmentType: "full_time",
      salary: {
        min: 150000,
        max: 180000,
        currency: "USD",
        period: "year",
        annualMin: 150000,
        annualMax: 180000,
        raw: "$150k - $180k",
        hasEquity: true,
      },
      postedAt: "2026-09-28T00:00:00.000Z",
      scrapedAt: "2026-09-28T00:00:00.000Z",
      url: "https://example.com/job/1",
      applyUrl: "https://example.com/apply/1",
      description: "Sample description",
      skills: ["React", "Node.js"],
      seniority: "senior",
      yearsOfExperience: 5,
      isDirectAts: false,
      companyStage: "growth",
      applicants: 12,
      companyLogo: null,
      companyUrl: null,
      seenOn: ["linkedin", "indeed"],
      urls: {
        linkedin: "https://linkedin.com/jobs/1",
        indeed: "https://indeed.com/viewjob?jk=1",
      },
      score: 95,
      scoreReasons: ["fresh", "salary listed"],
      isNew: true,
      extra: {},
    },
  ];

  it("formats jobs to CSV properly escaping quotes and delimiters", () => {
    const csv = jobsToCsv(sampleJobs);
    expect(csv).toContain("id,title,company");
    expect(csv).toContain("Senior Software Engineer");
    expect(csv).toContain('"San Diego, CA"');
    expect(csv).toContain("linkedin;indeed");
    expect(csv).toContain("150000");
  });

  it("formats jobs to JSONL/NDJSON", () => {
    const jsonl = jobsToJsonl(sampleJobs);
    expect(jsonl).toContain('"id":"test1"');
    expect(jsonl.split("\n")).toHaveLength(1);
  });
});
