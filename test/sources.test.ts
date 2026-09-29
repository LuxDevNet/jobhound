import { describe, it, expect } from "vitest";
import {
  parseBoard,
  boardRequests,
  sourceOfLabel,
  SOURCES,
} from "../src/sources.ts";
import type { SearchQuery } from "../src/model.ts";
import type { Input } from "../src/input.ts";

const dummyQuery: SearchQuery = {
  keywords: "software engineer",
  location: "San Francisco, CA",
  country: "US",
  radiusMiles: 25,
  postedWithinDays: 14,
  remoteOnly: false,
  minSalary: 100000,
  employmentTypes: ["full_time"],
  maxResultsPerSource: 50,
};

const dummyInput: Input = {
  keywords: "software engineer",
  location: "San Francisco, CA",
  country: "US",
  radiusMiles: 25,
  postedWithinDays: 14,
  remoteOnly: false,
  minSalary: 100000,
  employmentTypes: ["full_time"],
  sources: ["greenhouse", "lever", "ashby"],
  maxResultsPerSource: 50,
  startUrls: [],
  companyBoards: [],
  fetchDetails: true,
  titleInclude: [],
  titleExclude: [],
  excludeCompanies: [],
  keepUnknownSalary: true,
  onlyNew: false,
  stateKey: "default",
  maxConcurrency: 8,
  browserMaxConcurrency: 3,
  maxRequestRetries: 3,
  shardTotal: 1,
  shardIndex: 0,
  scrapling: false,
  stealthHeaders: true,
  humanEmulation: false,
  baseUrls: {},
  outputFormat: "json",
  diceApiKey: "test-key",
  debug: false,
};

describe("sources.ts", () => {
  describe("parseBoard", () => {
    it("parses Greenhouse URLs and shorthand", () => {
      expect(parseBoard("greenhouse:stripe")).toEqual({ ats: "greenhouse", slug: "stripe" });
      expect(parseBoard("gh:stripe")).toEqual({ ats: "greenhouse", slug: "stripe" });
      expect(parseBoard("https://boards.greenhouse.io/airbnb")).toEqual({ ats: "greenhouse", slug: "airbnb" });
      expect(parseBoard("https://job-boards.eu.greenhouse.io/spotify")).toEqual({ ats: "greenhouse", slug: "spotify" });
      expect(parseBoard("https://greenhouse.io/embed/job_board?for=figma")).toEqual({ ats: "greenhouse", slug: "figma" });
    });

    it("parses Lever URLs and shorthand", () => {
      expect(parseBoard("lever:palantir")).toEqual({ ats: "lever", slug: "palantir" });
      expect(parseBoard("lv:palantir")).toEqual({ ats: "lever", slug: "palantir" });
      expect(parseBoard("https://jobs.lever.co/netflix")).toEqual({ ats: "lever", slug: "netflix" });
    });

    it("parses Ashby URLs and shorthand", () => {
      expect(parseBoard("ashby:ramp")).toEqual({ ats: "ashby", slug: "ramp" });
      expect(parseBoard("ab:ramp")).toEqual({ ats: "ashby", slug: "ramp" });
      expect(parseBoard("https://jobs.ashbyhq.com/openai")).toEqual({ ats: "ashby", slug: "openai" });
    });

    it("parses SmartRecruiters URLs and shorthand", () => {
      expect(parseBoard("smartrecruiters:uber")).toEqual({ ats: "smartrecruiters", slug: "uber" });
      expect(parseBoard("sr:uber")).toEqual({ ats: "smartrecruiters", slug: "uber" });
      expect(parseBoard("https://jobs.smartrecruiters.com/Square")).toEqual({ ats: "smartrecruiters", slug: "Square" });
      expect(parseBoard("https://careers.smartrecruiters.com/Visa")).toEqual({ ats: "smartrecruiters", slug: "Visa" });
    });

    it("parses Workday URLs and shorthand", () => {
      expect(parseBoard("workday:nvidia/External")).toEqual({ ats: "workday", slug: "nvidia", subpath: "External" });
      expect(parseBoard("wd:apple:careers")).toEqual({ ats: "workday", slug: "apple", subpath: "careers" });
      expect(parseBoard("https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite")).toEqual({
        ats: "workday",
        slug: "nvidia",
        subpath: "NVIDIAExternalCareerSite",
        domain: "nvidia.wd5.myworkdayjobs.com",
      });
    });

    it("parses Jobvite URLs and shorthand", () => {
      expect(parseBoard("jobvite:hulu")).toEqual({ ats: "jobvite", slug: "hulu" });
      expect(parseBoard("jv:hulu")).toEqual({ ats: "jobvite", slug: "hulu" });
      expect(parseBoard("https://jobs.jobvite.com/linkedin")).toEqual({ ats: "jobvite", slug: "linkedin" });
    });

    it("parses Workable, Breezy, and Recruitee", () => {
      expect(parseBoard("workable:monzo")).toEqual({ ats: "workable", slug: "monzo" });
      expect(parseBoard("breezy:acme")).toEqual({ ats: "breezy", slug: "acme" });
      expect(parseBoard("recruitee:deliveroo")).toEqual({ ats: "recruitee", slug: "deliveroo" });
      expect(parseBoard("https://apply.workable.com/monzo")).toEqual({ ats: "workable", slug: "monzo" });
      expect(parseBoard("https://acme.breezy.hr")).toEqual({ ats: "breezy", slug: "acme" });
      expect(parseBoard("https://deliveroo.recruitee.com")).toEqual({ ats: "recruitee", slug: "deliveroo" });
    });

    it("returns null for non-board string", () => {
      expect(parseBoard("https://example.com/not-an-ats")).toBeNull();
      expect(parseBoard("")).toBeNull();
    });
  });

  describe("boardRequests", () => {
    it("generates correct API requests for various ATS boards", () => {
      const reqs = boardRequests([
        "greenhouse:stripe",
        "lever:palantir",
        "ashby:ramp",
        "smartrecruiters:uber",
        "workday:nvidia/External",
        "jobvite:hulu",
        "workable:monzo",
        "breezy:acme",
        "recruitee:deliveroo",
      ]);

      expect(reqs).toHaveLength(9);
      expect(reqs[0]!.url).toBe("https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true");
      expect(reqs[0]!.label).toBe("greenhouse:board");

      expect(reqs[1]!.url).toBe("https://api.lever.co/v0/postings/palantir?mode=json");
      expect(reqs[1]!.label).toBe("lever:board");

      expect(reqs[2]!.url).toBe("https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true");
      expect(reqs[2]!.label).toBe("ashby:board");

      expect(reqs[3]!.url).toBe("https://api.smartrecruiters.com/v1/companies/uber/postings?limit=100");
      expect(reqs[3]!.label).toBe("smartrecruiters:board");

      expect(reqs[4]!.url).toBe("https://nvidia.myworkdayjobs.com/wday/cxs/nvidia/External/jobs");
      expect(reqs[4]!.label).toBe("workday:board");

      expect(reqs[5]!.url).toBe("https://app.jobvite.com/CompanyJobs/Xml.aspx?c=hulu");
      expect(reqs[5]!.label).toBe("jobvite:board");
    });
  });

  describe("sourceOfLabel", () => {
    it("maps labels back to SourceId", () => {
      expect(sourceOfLabel("greenhouse:board")).toBe("greenhouse");
      expect(sourceOfLabel("wwr:rss")).toBe("weworkremotely");
      expect(sourceOfLabel("hn:thread")).toBe("hackernews");
      expect(sourceOfLabel("smartrecruiters:board")).toBe("smartrecruiters");
      expect(sourceOfLabel("workday:board")).toBe("workday");
      expect(sourceOfLabel("linkedin:list")).toBe("linkedin");
    });
  });

  describe("ATS Handlers", () => {
    it("handles SmartRecruiters board payload and detail queueing", () => {
      const handler = SOURCES.smartrecruiters.handle["smartrecruiters:board"];
      const srJson = {
        content: [
          {
            id: "12345",
            name: "Senior Software Engineer",
            company: { name: "Uber" },
            location: { city: "San Francisco", region: "CA", country: "US", remote: true },
            typeOfEmployment: { label: "Full-time" },
            releasedDate: "2026-06-01T12:00:00Z",
          },
        ],
      };

      const result = handler!({
        url: "https://api.smartrecruiters.com/v1/companies/uber/postings",
        body: JSON.stringify(srJson),
        json: srJson,
        userData: { slug: "uber", company: "Uber" },
        q: dummyQuery,
        input: dummyInput,
      });

      expect(result.next).toHaveLength(1);
      expect(result.next![0]!.label).toBe("smartrecruiters:detail");
      expect(result.next![0]!.url).toContain("12345");
    });

    it("handles Jobvite XML feed payload", () => {
      const handler = SOURCES.jobvite.handle["jobvite:board"];
      const xmlBody = `
        <result>
          <job>
            <id>jv-123</id>
            <title>Principal Software Engineer</title>
            <location>San Francisco, CA</location>
            <date>6/1/2026</date>
            <detail-url>https://jobs.jobvite.com/hulu/job/jv-123</detail-url>
            <category>Engineering</category>
            <job-type>Full-Time</job-type>
            <description><![CDATA[<p>Lead core streaming infrastructure.</p>]]></description>
          </job>
        </result>
      `;

      const result = handler!({
        url: "https://app.jobvite.com/CompanyJobs/Xml.aspx?c=hulu",
        body: xmlBody,
        json: null,
        userData: { slug: "hulu", company: "Hulu" },
        q: dummyQuery,
        input: dummyInput,
      });

      expect(result.jobs).toHaveLength(1);
      const job = result.jobs[0]!;
      expect(job.title).toBe("Principal Software Engineer");
      expect(job.company).toBe("Hulu");
      expect(job.location).toBe("San Francisco, CA");
      expect(job.employmentType).toBe("full_time");
    });

    it("handles Greenhouse pay transparency and metadata", () => {
      const handler = SOURCES.greenhouse.handle["greenhouse:board"];
      const ghJson = {
        jobs: [
          {
            id: 98765,
            title: "Staff Software Engineer",
            location: { name: "San Francisco, CA / Remote" },
            absolute_url: "https://boards.greenhouse.io/stripe/jobs/98765",
            first_published: "2026-06-01T00:00:00Z",
            content: "&lt;p&gt;Build global payment APIs.&lt;/p&gt;",
            pay_transparency: {
              min: 190000,
              max: 240000,
              currency: "USD",
              interval: "annual",
            },
          },
        ],
      };

      const result = handler!({
        url: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs?content=true",
        body: JSON.stringify(ghJson),
        json: ghJson,
        userData: { slug: "stripe", company: "Stripe" },
        q: dummyQuery,
        input: dummyInput,
      });

      expect(result.jobs).toHaveLength(1);
      const job = result.jobs[0]!;
      expect(job.title).toBe("Staff Software Engineer");
      expect(job.salary?.annualMin).toBe(190000);
      expect(job.salary?.annualMax).toBe(240000);
    });
  });
});
