import { describe, it, expect } from "vitest";
import {
  detectWorkMode,
  detectEmploymentType,
  normCompany,
  normTitle,
  normTitleLoose,
  normCity,
  slug,
  hash,
} from "../src/lib/text.ts";

describe("text.ts", () => {
  describe("detectWorkMode", () => {
    it("returns null when all inputs are falsy or empty", () => {
      expect(detectWorkMode()).toBeNull();
      expect(detectWorkMode(null, undefined, "")).toBeNull();
      expect(detectWorkMode(false)).toBeNull();
    });

    it("detects remote when a boolean true is passed", () => {
      expect(detectWorkMode(true)).toBe("remote");
      expect(detectWorkMode(null, true, "On-site office")).toBe("remote");
    });

    it("detects hybrid work mode", () => {
      expect(detectWorkMode("Hybrid - 2 days in office")).toBe("hybrid");
      expect(detectWorkMode("Role is hybrid remote")).toBe("hybrid");
    });

    it("detects remote work mode from text keywords", () => {
      expect(detectWorkMode("Fully remote role")).toBe("remote");
      expect(detectWorkMode("Work from home available")).toBe("remote");
      expect(detectWorkMode("100% WFH")).toBe("remote");
      expect(detectWorkMode("Telecommute option")).toBe("remote");
      expect(detectWorkMode("Work from anywhere")).toBe("remote");
    });

    it("detects onsite work mode", () => {
      expect(detectWorkMode("Onsite in San Diego")).toBe("onsite");
      expect(detectWorkMode("On-site role")).toBe("onsite");
      expect(detectWorkMode("In-office 5 days a week")).toBe("onsite");
      expect(detectWorkMode("In person work")).toBe("onsite");
    });
  });

  describe("detectEmploymentType", () => {
    it("returns null when inputs are falsy or unmatching", () => {
      expect(detectEmploymentType()).toBeNull();
      expect(detectEmploymentType(null, undefined, "")).toBeNull();
      expect(detectEmploymentType("unknown type")).toBeNull();
    });

    it("detects internship", () => {
      expect(detectEmploymentType("Summer Intern")).toBe("internship");
      expect(detectEmploymentType("Engineering Internship")).toBe("internship");
    });

    it("detects freelance", () => {
      expect(detectEmploymentType("Freelance Developer")).toBe("freelance");
      expect(detectEmploymentType("Hourly rate basis")).toBe("freelance");
      expect(detectEmploymentType("Fixed price project")).toBe("freelance");
      expect(detectEmploymentType("Fixed budget")).toBe("freelance");
    });

    it("detects contract", () => {
      expect(detectEmploymentType("Contract role")).toBe("contract");
      expect(detectEmploymentType("Independent Contractor")).toBe("contract");
      expect(detectEmploymentType("C2C corp to corp")).toBe("contract");
      expect(detectEmploymentType("1099 position")).toBe("contract");
    });

    it("detects temporary", () => {
      expect(detectEmploymentType("Temporary coverage")).toBe("temporary");
      expect(detectEmploymentType("Temp assignment")).toBe("temporary");
      expect(detectEmploymentType("Seasonal worker")).toBe("temporary");
    });

    it("detects part_time", () => {
      expect(detectEmploymentType("Part-time position")).toBe("part_time");
      expect(detectEmploymentType("part_time")).toBe("part_time");
      expect(detectEmploymentType("20 hours part time")).toBe("part_time");
    });

    it("detects full_time", () => {
      expect(detectEmploymentType("Full-time position")).toBe("full_time");
      expect(detectEmploymentType("full_time")).toBe("full_time");
      expect(detectEmploymentType("Permanent staff")).toBe("full_time");
      expect(detectEmploymentType("Regular employee")).toBe("full_time");
    });
  });

  describe("normCompany", () => {
    it("normalizes company names by lowercasing and stripping company suffixes", () => {
      expect(normCompany("Acme, Inc.")).toBe("acme");
      expect(normCompany("Globex Corporation")).toBe("globex");
      expect(normCompany("Initech LLC")).toBe("initech");
      expect(normCompany("Wayne Enterprises Ltd.")).toBe("wayneenterprises");
      expect(normCompany("The Big Corp")).toBe("big");
      expect(normCompany("Siemens AG")).toBe("siemens");
      expect(normCompany("SAP SE")).toBe("sapse"); // 'se' is not in suffix list, but clean
      expect(normCompany("Bosch GmbH")).toBe("bosch");
      expect(normCompany("Barclays PLC")).toBe("barclays");
      expect(normCompany("Smith & Wesson Holdings")).toBe("smithandwesson");
      expect(normCompany(null)).toBe("");
      expect(normCompany(undefined)).toBe("");
    });
  });

  describe("normTitle", () => {
    it("normalizes job titles by lowercasing, expanding abbreviations, removing bracketed/hyphenated noise", () => {
      expect(normTitle("Sr. Software Eng (Fullstack) - Remote")).toBe("seniorsoftwareengineer");
      expect(normTitle("Jr. Backend Eng [Node.js]")).toBe("juniorbackendengineer");
      expect(normTitle("Lead Data Eng - On-site")).toBe("leaddataengineer");
      expect(normTitle(null)).toBe("");
      expect(normTitle(undefined)).toBe("");
    });
  });

  describe("normTitleLoose", () => {
    it("removes seniority words and title noise", () => {
      expect(normTitleLoose("Senior Software Engineer")).toBe("softwareengineer");
      expect(normTitleLoose("Sr. Software Engineer")).toBe("softwareengineer");
      expect(normTitleLoose("Junior Frontend Developer")).toBe("frontenddeveloper");
      expect(normTitleLoose("Staff Backend Engineer")).toBe("backendengineer");
      expect(normTitleLoose("Principal Systems Architect")).toBe("systemsarchitect");
      expect(normTitleLoose("Lead Software Eng")).toBe("softwareengineer");
      expect(normTitleLoose("Software Engineer III")).toBe("softwareengineer");
    });
  });

  describe("normCity", () => {
    it("extracts and normalizes city names from formatted location strings", () => {
      expect(normCity("San Francisco, CA")).toBe("sanfrancisco");
      expect(normCity("Greater New York Area")).toBe("newyork");
      expect(normCity("Austin (Metro)")).toBe("austin");
      expect(normCity("Seattle • WA")).toBe("seattle");
      expect(normCity("Chicago · IL")).toBe("chicago");
      expect(normCity(null)).toBe("");
      expect(normCity("")).toBe("");
    });
  });

  describe("slug", () => {
    it("turns strings into clean kebab-case slugs", () => {
      expect(slug("San Diego 120k+")).toBe("san-diego-120k");
      expect(slug("Senior Full-Stack Engineer (Remote)")).toBe("senior-full-stack-engineer-remote");
      expect(slug("  -- leading and trailing --  ")).toBe("leading-and-trailing");
    });
  });

  describe("hash", () => {
    it("produces deterministic FNV-1a base36 hashes", () => {
      const h1 = hash("google-seniorengineer-mountainview");
      const h2 = hash("google-seniorengineer-mountainview");
      const h3 = hash("meta-seniorengineer-menlopark");

      expect(h1).toBe(h2);
      expect(typeof h1).toBe("string");
      expect(h1.length).toBeGreaterThan(0);
      expect(h1).not.toBe(h3);
    });

    it("hashes empty strings consistently", () => {
      expect(hash("")).toBe((0x811c9dc5 >>> 0).toString(36));
    });
  });
});
