import { describe, it, expect } from "vitest";
import { detectSeniority, extractYearsOfExperience } from "../src/lib/text.ts";
import { isDirectApplyUrl } from "../src/lib/urls.ts";
import { InputSchema, toQuery } from "../src/input.ts";

describe("High-Quality Precision Filters", () => {
  describe("detectSeniority", () => {
    it("detects staff and principal levels", () => {
      expect(detectSeniority("Staff Software Engineer")).toBe("staff");
      expect(detectSeniority("Principal Distributed Systems Architect")).toBe("principal");
    });

    it("detects lead and senior levels", () => {
      expect(detectSeniority("Tech Lead - Core Infrastructure")).toBe("lead");
      expect(detectSeniority("Senior Full Stack Developer")).toBe("senior");
    });

    it("detects entry and intern levels", () => {
      expect(detectSeniority("Junior Web Developer")).toBe("entry");
      expect(detectSeniority("Software Engineering Intern")).toBe("intern");
    });

    it("detects executive and director levels", () => {
      expect(detectSeniority("VP of Engineering")).toBe("executive");
      expect(detectSeniority("Director of Product Security")).toBe("director");
    });
  });

  describe("extractYearsOfExperience", () => {
    it("extracts min and max years ranges", () => {
      const exp = extractYearsOfExperience("Requires 5-8 years of experience in distributed systems.");
      expect(exp).toEqual({ min: 5, max: 8 });
    });

    it("extracts minimum threshold years", () => {
      const exp1 = extractYearsOfExperience("Must have at least 3 years of experience with React and TypeScript.");
      expect(exp1?.min).toBe(3);

      const exp2 = extractYearsOfExperience("7+ years of software engineering experience.");
      expect(exp2?.min).toBe(7);
    });
  });

  describe("isDirectApplyUrl (ATS Filter)", () => {
    it("identifies direct ATS applicant tracking URLs", () => {
      expect(isDirectApplyUrl("https://boards.greenhouse.io/stripe/jobs/123")).toBe(true);
      expect(isDirectApplyUrl("https://jobs.lever.co/palantir/abc")).toBe(true);
      expect(isDirectApplyUrl("https://jobs.ashbyhq.com/ramp/xyz")).toBe(true);
      expect(isDirectApplyUrl("https://jobs.smartrecruiters.com/visa/999")).toBe(true);
    });

    it("returns false for job aggregator boards", () => {
      expect(isDirectApplyUrl("https://www.linkedin.com/jobs/view/123")).toBe(false);
      expect(isDirectApplyUrl("https://www.indeed.com/viewjob?jk=abc")).toBe(false);
    });
  });

  describe("InputSchema with advanced filters", () => {
    it("validates and parses advanced filter inputs", () => {
      const parsed = InputSchema.parse({
        keywords: "Staff Engineer",
        seniorityLevels: ["staff", "principal"],
        minYearsExperience: 5,
        maxYearsExperience: 10,
        skillsInclude: ["Kubernetes", "Golang"],
        skillsExclude: ["PHP"],
        requireEquity: true,
        directApplyOnly: true,
        maxApplicants: 30,
        descriptionInclude: ["Remote-first"],
        descriptionExclude: ["Clearance required"],
        workModes: ["remote"],
      });

      expect(parsed.seniorityLevels).toEqual(["staff", "principal"]);
      expect(parsed.minYearsExperience).toBe(5);
      expect(parsed.requireEquity).toBe(true);
      expect(parsed.directApplyOnly).toBe(true);
      expect(parsed.maxApplicants).toBe(30);

      const q = toQuery(parsed);
      expect(q.seniorityLevels).toEqual(["staff", "principal"]);
      expect(q.skillsInclude).toEqual(["Kubernetes", "Golang"]);
    });
  });
});
