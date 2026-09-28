import { describe, it, expect } from "vitest";
import { parsePeriod, normalizePeriod, buildSalary, formatSalary } from "../src/lib/salary.ts";

describe("salary.ts", () => {
  describe("parsePeriod", () => {
    it("returns null for empty, null, or undefined values", () => {
      expect(parsePeriod(null)).toBeNull();
      expect(parsePeriod(undefined)).toBeNull();
      expect(parsePeriod("")).toBeNull();
    });

    it("parses hourly patterns", () => {
      expect(parsePeriod("per hour")).toBe("hour");
      expect(parsePeriod("$50/hr")).toBe("hour");
      expect(parsePeriod("100 /h")).toBe("hour");
      expect(parsePeriod("hourly rate")).toBe("hour");
      expect(parsePeriod("25 an hour")).toBe("hour");
      expect(parsePeriod("hr")).toBe("hour");
    });

    it("parses daily patterns", () => {
      expect(parsePeriod("per day")).toBe("day");
      expect(parsePeriod("$500/day")).toBe("day");
      expect(parsePeriod("daily rate")).toBe("day");
    });

    it("parses weekly patterns", () => {
      expect(parsePeriod("per week")).toBe("week");
      expect(parsePeriod("$2,000/wk")).toBe("week");
      expect(parsePeriod("weekly")).toBe("week");
      expect(parsePeriod("wk")).toBe("week");
    });

    it("parses monthly patterns", () => {
      expect(parsePeriod("per month")).toBe("month");
      expect(parsePeriod("$8,000/mo")).toBe("month");
      expect(parsePeriod("monthly")).toBe("month");
      expect(parsePeriod("mo")).toBe("month");
    });

    it("parses yearly patterns", () => {
      expect(parsePeriod("per year")).toBe("year");
      expect(parsePeriod("a year")).toBe("year");
      expect(parsePeriod("$150,000/yr")).toBe("year");
      expect(parsePeriod("annual salary")).toBe("year");
      expect(parsePeriod("annually")).toBe("year");
      expect(parsePeriod("120k yr")).toBe("year");
      expect(parsePeriod("100k p.a.")).toBe("year");
      expect(parsePeriod("80k pa")).toBe("year");
    });

    it("parses fixed patterns", () => {
      expect(parsePeriod("fixed price")).toBe("fixed");
      expect(parsePeriod("Fixed budget")).toBe("fixed");
    });

    it("returns null for unrecognized period strings", () => {
      expect(parsePeriod("random text")).toBeNull();
    });
  });

  describe("normalizePeriod", () => {
    it("returns null for falsy inputs", () => {
      expect(normalizePeriod(null)).toBeNull();
      expect(normalizePeriod(undefined)).toBeNull();
      expect(normalizePeriod("")).toBeNull();
    });

    it("normalizes hour prefixes and shorthands", () => {
      expect(normalizePeriod("hourly")).toBe("hour");
      expect(normalizePeriod("hours")).toBe("hour");
      expect(normalizePeriod("hr")).toBe("hour");
    });

    it("normalizes day prefixes", () => {
      expect(normalizePeriod("day")).toBe("day");
      expect(normalizePeriod("daily")).toBe("day");
    });

    it("normalizes week prefixes", () => {
      expect(normalizePeriod("week")).toBe("week");
      expect(normalizePeriod("weekly")).toBe("week");
    });

    it("normalizes month prefixes", () => {
      expect(normalizePeriod("month")).toBe("month");
      expect(normalizePeriod("monthly")).toBe("month");
    });

    it("normalizes year and annual prefixes", () => {
      expect(normalizePeriod("year")).toBe("year");
      expect(normalizePeriod("yearly")).toBe("year");
      expect(normalizePeriod("annual")).toBe("year");
      expect(normalizePeriod("annually")).toBe("year");
      expect(normalizePeriod("yr")).toBe("year");
    });

    it("normalizes fixed prefixes", () => {
      expect(normalizePeriod("fixed")).toBe("fixed");
      expect(normalizePeriod("fixed-price")).toBe("fixed");
    });

    it("falls back to parsePeriod for phrase strings", () => {
      expect(normalizePeriod("paid per month")).toBe("month");
    });
  });

  describe("buildSalary", () => {
    it("returns null for null/undefined inputs", () => {
      expect(buildSalary(null)).toBeNull();
      expect(buildSalary(undefined)).toBeNull();
    });

    it("handles string input with salary range and period", () => {
      const sal = buildSalary("$120,000 - $150,000 a year");
      expect(sal).toEqual({
        min: 120000,
        max: 150000,
        currency: "USD",
        period: "year",
        annualMin: 120000,
        annualMax: 150000,
        raw: "$120,000 - $150,000 a year",
      });
    });

    it("handles Google Jobs en-dash format '120–150K a year'", () => {
      const sal = buildSalary("$120–150K a year");
      expect(sal).not.toBeNull();
      expect(sal?.min).toBe(120000);
      expect(sal?.max).toBe(150000);
      expect(sal?.annualMin).toBe(120000);
      expect(sal?.annualMax).toBe(150000);
      expect(sal?.period).toBe("year");
    });

    it("handles 'up to $X' format", () => {
      const sal = buildSalary("Up to $150,000 a year");
      expect(sal?.min).toBeNull();
      expect(sal?.max).toBe(150000);
      expect(sal?.annualMin).toBeNull();
      expect(sal?.annualMax).toBe(150000);
    });

    it("handles hourly rates and computes annual values with multiplier 2080", () => {
      const sal = buildSalary("$50 - $75 / hr");
      expect(sal?.min).toBe(50);
      expect(sal?.max).toBe(75);
      expect(sal?.period).toBe("hour");
      expect(sal?.annualMin).toBe(50 * 2080);
      expect(sal?.annualMax).toBe(75 * 2080);
    });

    it("guesses period from magnitude when no period specified", () => {
      // < 500 -> hour
      const hourly = buildSalary({ min: 60, max: 80 });
      expect(hourly?.annualMin).toBe(60 * 2080);
      expect(hourly?.annualMax).toBe(80 * 2080);

      // 500 to 20000 -> month
      const monthly = buildSalary({ min: 5000, max: 8000 });
      expect(monthly?.annualMin).toBe(5000 * 12);
      expect(monthly?.annualMax).toBe(8000 * 12);

      // >= 20000 -> year
      const yearly = buildSalary({ min: 100000, max: 130000 });
      expect(yearly?.annualMin).toBe(100000);
      expect(yearly?.annualMax).toBe(130000);
    });

    it("swaps min and max when min > max", () => {
      const sal = buildSalary({ min: 150000, max: 120000, period: "year" });
      expect(sal?.min).toBe(120000);
      expect(sal?.max).toBe(150000);
    });

    it("detects various currency symbols from raw text", () => {
      expect(buildSalary("€80,000 / year")?.currency).toBe("EUR");
      expect(buildSalary("£70k - £90k annually")?.currency).toBe("GBP");
      expect(buildSalary("CA$90,000/yr")?.currency).toBe("CAD");
      expect(buildSalary("A$110,000/yr")?.currency).toBe("AUD");
      expect(buildSalary("₹1,500,000 per year")?.currency).toBe("INR");
    });

    it("handles multiplier for day (260), week (52), and fixed (null)", () => {
      const daily = buildSalary({ min: 500, max: 600, period: "day" });
      expect(daily?.annualMin).toBe(500 * 260);
      expect(daily?.annualMax).toBe(600 * 260);

      const weekly = buildSalary({ min: 2000, max: 3000, period: "week" });
      expect(weekly?.annualMin).toBe(2000 * 52);
      expect(weekly?.annualMax).toBe(3000 * 52);

      const fixed = buildSalary({ min: 5000, max: 5000, period: "fixed" });
      expect(fixed?.annualMin).toBeNull();
      expect(fixed?.annualMax).toBeNull();
    });

    it("returns raw object when raw text contains no extractable numbers", () => {
      const sal = buildSalary("Competitive salary based on experience");
      expect(sal).toEqual({
        min: null,
        max: null,
        currency: null,
        period: null,
        annualMin: null,
        annualMax: null,
        raw: "Competitive salary based on experience",
      });
    });

    it("handles single amount extraction with 'm' suffix (millions)", () => {
      const sal = buildSalary("$1.2M - $1.5M / year");
      expect(sal?.min).toBe(1200000);
      expect(sal?.max).toBe(1500000);
    });
  });

  describe("formatSalary", () => {
    it("returns empty string for null salary", () => {
      expect(formatSalary(null)).toBe("");
    });

    it("returns raw text when annualMin and annualMax are null", () => {
      expect(formatSalary({
        min: null, max: null, currency: null, period: null, annualMin: null, annualMax: null, raw: "Competitive",
      })).toBe("Competitive");
    });

    it("formats standard USD salary range", () => {
      expect(formatSalary({
        min: 120000, max: 150000, currency: "USD", period: "year", annualMin: 120000, annualMax: 150000, raw: null,
      })).toBe("$120k-150k/yr");
    });

    it("formats single salary value", () => {
      expect(formatSalary({
        min: 120000, max: 120000, currency: "USD", period: "year", annualMin: 120000, annualMax: 120000, raw: null,
      })).toBe("$120k/yr");
    });

    it("formats non-USD currency with space", () => {
      expect(formatSalary({
        min: 80000, max: 95000, currency: "EUR", period: "year", annualMin: 80000, annualMax: 95000, raw: null,
      })).toBe("EUR 80k-95k/yr");
    });

    it("indicates origin period if not yearly", () => {
      expect(formatSalary({
        min: 50, max: 60, currency: "USD", period: "hour", annualMin: 104000, annualMax: 124800, raw: null,
      })).toBe("$104k-125k/yr (from hour)");
    });

    it("formats numbers under 1000 without k suffix", () => {
      expect(formatSalary({
        min: 500, max: 800, currency: "USD", period: "year", annualMin: 500, annualMax: 800, raw: null,
      })).toBe("$500-800/yr");
    });
  });
});
