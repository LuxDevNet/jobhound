import { describe, it, expect } from "vitest";
import {
  detectSource,
  cleanUrl,
  indeedTypeCodes,
  buildIndeedUrl,
  INDEED_ATTR,
} from "../src/lib/urls.ts";
import type { SearchQuery } from "../src/model.ts";

describe("urls.ts", () => {
  describe("detectSource", () => {
    it("detects major job boards from hostnames", () => {
      expect(detectSource("https://www.linkedin.com/jobs/view/123456")).toBe("linkedin");
      expect(detectSource("https://linkedin.com/in/test")).toBe("linkedin");
      expect(detectSource("https://www.indeed.com/viewjob?jk=123")).toBe("indeed");
      expect(detectSource("https://ca.indeed.com/jobs?q=dev")).toBe("indeed");
      expect(detectSource("https://www.glassdoor.com/job-listing/123")).toBe("glassdoor");
      expect(detectSource("https://wellfound.com/jobs/123")).toBe("wellfound");
      expect(detectSource("https://angel.co/company/test/jobs")).toBe("wellfound");
      expect(detectSource("https://www.upwork.com/freelance-jobs/123")).toBe("upwork");
      expect(detectSource("https://www.ziprecruiter.com/jobs/123")).toBe("ziprecruiter");
      expect(detectSource("https://www.dice.com/job-detail/123")).toBe("dice");
      expect(detectSource("https://www.monster.com/job-openings/123")).toBe("monster");
      expect(detectSource("https://www.simplyhired.com/job/123")).toBe("simplyhired");
      expect(detectSource("https://remoteok.com/remote-jobs/123")).toBe("remoteok");
      expect(detectSource("https://remoteok.io/remote-jobs/123")).toBe("remoteok");
      expect(detectSource("https://builtin.com/jobs/123")).toBe("builtin");
      expect(detectSource("https://builtinaustin.com/jobs/123")).toBe("builtin");
    });

    it("returns null for unknown hosts or invalid URLs", () => {
      expect(detectSource("https://example.com/jobs/123")).toBeNull();
      expect(detectSource("not-a-valid-url")).toBeNull();
    });
  });

  describe("cleanUrl", () => {
    it("strips universal tracking parameters like utm_*, gclid, fbclid, ref", () => {
      const input = "https://example.com/job?id=123&utm_source=google&utm_medium=cpc&gclid=xyz&ref=partner";
      const result = cleanUrl(input);

      expect(result.url).toBe("https://example.com/job?id=123");
      expect(result.source).toBeNull();
      expect(result.removed).toEqual(expect.arrayContaining(["utm_source", "utm_medium", "gclid", "ref"]));
    });

    it("strips source-specific junk parameters for Indeed", () => {
      const input = "https://www.indeed.com/viewjob?jk=abc12345&from=serp&vjk=abc12345&tk=12345&utm_campaign=jobalert";
      const result = cleanUrl(input);

      expect(result.source).toBe("indeed");
      expect(result.removed).toEqual(expect.arrayContaining(["from", "vjk", "tk", "utm_campaign"]));
      // Note: 'jk' is in JUNK_PARAMS.indeed
      expect(result.removed).toContain("jk");
    });

    it("strips source-specific junk parameters for LinkedIn", () => {
      const input = "https://www.linkedin.com/jobs/view/123456789/?currentJobId=123456789&trk=public_jobs&lipi=urn%3Ali%3Apage&q=engineer";
      const result = cleanUrl(input);

      expect(result.source).toBe("linkedin");
      expect(result.url).toBe("https://www.linkedin.com/jobs/view/123456789/?q=engineer");
      expect(result.removed).toEqual(expect.arrayContaining(["currentJobId", "trk", "lipi"]));
    });

    it("strips source-specific junk parameters for Glassdoor", () => {
      const input = "https://www.glassdoor.com/Job/san-diego-engineer-jobs?jl=123456&src=GD_JOB_AD&guid=abcdef";
      const result = cleanUrl(input);

      expect(result.source).toBe("glassdoor");
      expect(result.url).toBe("https://www.glassdoor.com/Job/san-diego-engineer-jobs");
      expect(result.removed).toEqual(expect.arrayContaining(["jl", "src", "guid"]));
    });

    it("preserves query string without junk parameters intact", () => {
      const input = "https://example.com/search?keyword=typescript&location=sandiego";
      const result = cleanUrl(input);

      expect(result.url).toBe("https://example.com/search?keyword=typescript&location=sandiego");
      expect(result.removed).toEqual([]);
    });
  });

  describe("indeedTypeCodes", () => {
    it("maps employment types to Indeed attribute codes", () => {
      expect(indeedTypeCodes(["full_time"])).toEqual([INDEED_ATTR.full_time]);
      expect(indeedTypeCodes(["part_time"])).toEqual([INDEED_ATTR.part_time]);
      expect(indeedTypeCodes(["contract"])).toEqual([INDEED_ATTR.contract]);
      expect(indeedTypeCodes(["freelance"])).toEqual([INDEED_ATTR.contract]);
      expect(indeedTypeCodes(["temporary"])).toEqual([INDEED_ATTR.temporary]);
      expect(indeedTypeCodes(["internship"])).toEqual([INDEED_ATTR.internship]);
    });

    it("deduplicates attribute codes when contract and freelance are both present", () => {
      const codes = indeedTypeCodes(["contract", "freelance"]);
      expect(codes).toEqual([INDEED_ATTR.contract]);
    });

    it("handles undefined or empty list", () => {
      expect(indeedTypeCodes(undefined)).toEqual([]);
      expect(indeedTypeCodes([])).toEqual([]);
    });
  });

  describe("buildIndeedUrl", () => {
    const baseQuery: SearchQuery = {
      keywords: "Software Engineer",
      location: "San Diego, CA",
      country: "US",
      radiusMiles: 25,
      postedWithinDays: 7,
      remoteOnly: false,
      minSalary: 120000,
      employmentTypes: ["full_time"],
      maxResultsPerSource: 50,
    };

    it("builds a complete Indeed search URL with all query parameters", () => {
      const url = buildIndeedUrl(baseQuery);
      expect(url).toContain("https://www.indeed.com/jobs?");
      expect(url).toContain("q=Software+Engineer");
      expect(url).toContain("l=San+Diego%2C+CA");
      expect(url).toContain("radius=25");
      expect(url).toContain("salaryType=%24120%2C000%2B");
      expect(url).toContain("fromage=7");
      expect(url).toContain("sort=date");
      // attr code for full_time (CF3CP)
      expect(url).toContain(encodeURIComponent("0kf:attr(CF3CP);"));
    });

    it("handles multiple employment types with OR encoding", () => {
      const query: SearchQuery = {
        ...baseQuery,
        employmentTypes: ["full_time", "contract"],
      };
      const url = buildIndeedUrl(query);
      // attr(CF3CP|NJXCK%2COR) inside 0kf:...;
      expect(url).toContain(encodeURIComponent("0kf:attr(CF3CP|NJXCK%2COR);"));
    });

    it("appends remote attribute when remoteOnly is true", () => {
      const query: SearchQuery = {
        ...baseQuery,
        remoteOnly: true,
        employmentTypes: ["full_time"],
      };
      const url = buildIndeedUrl(query);
      // attr(CF3CP)attr(DSQF7) inside 0kf:...;
      expect(url).toContain(encodeURIComponent(`0kf:attr(${INDEED_ATTR.full_time})attr(${INDEED_ATTR.remote});`));
    });

    it("supports international Indeed country domains", () => {
      const caQuery: SearchQuery = { ...baseQuery, country: "CA" };
      expect(buildIndeedUrl(caQuery)).toContain("https://ca.indeed.com/jobs?");

      const gbQuery: SearchQuery = { ...baseQuery, country: "GB" };
      expect(buildIndeedUrl(gbQuery)).toContain("https://uk.indeed.com/jobs?");

      const deQuery: SearchQuery = { ...baseQuery, country: "DE" };
      expect(buildIndeedUrl(deQuery)).toContain("https://de.indeed.com/jobs?");
    });

    it("includes pagination start parameter when start > 0", () => {
      const url = buildIndeedUrl(baseQuery, 20);
      expect(url).toContain("&start=20");
    });
  });
});
