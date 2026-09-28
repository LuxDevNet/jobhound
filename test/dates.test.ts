import { describe, it, expect } from "vitest";
import { parseDate, daysAgo, bucket } from "../src/lib/dates.ts";

describe("dates.ts", () => {
  const fixedNow = new Date("2026-06-15T12:00:00.000Z");

  describe("parseDate", () => {
    it("returns null for null, undefined, empty string, or non-dates", () => {
      expect(parseDate(null, fixedNow)).toBeNull();
      expect(parseDate(undefined, fixedNow)).toBeNull();
      expect(parseDate("", fixedNow)).toBeNull();
      expect(parseDate({}, fixedNow)).toBeNull();
      expect(parseDate(true, fixedNow)).toBeNull();
    });

    it("parses numeric epoch timestamps (seconds vs milliseconds)", () => {
      // Milliseconds (>= 1e12)
      const ms = fixedNow.getTime();
      expect(parseDate(ms, fixedNow)).toBe("2026-06-15T12:00:00.000Z");

      // Seconds (< 1e12)
      const sec = Math.floor(ms / 1000);
      expect(parseDate(sec, fixedNow)).toBe(new Date(sec * 1000).toISOString());

      // NaN / Infinity
      expect(parseDate(Number.NaN, fixedNow)).toBeNull();
      expect(parseDate(Number.POSITIVE_INFINITY, fixedNow)).toBeNull();
    });

    it("parses Date instances", () => {
      expect(parseDate(fixedNow, fixedNow)).toBe("2026-06-15T12:00:00.000Z");
      expect(parseDate(new Date("invalid"), fixedNow)).toBeNull();
    });

    it("parses numeric strings representing epoch timestamps (10 to 13 digits)", () => {
      const msStr = String(fixedNow.getTime());
      expect(parseDate(msStr, fixedNow)).toBe("2026-06-15T12:00:00.000Z");

      const secStr = String(Math.floor(fixedNow.getTime() / 1000));
      expect(parseDate(secStr, fixedNow)).toBe(new Date(Number(secStr) * 1000).toISOString());
    });

    it("parses instant/recent keywords as now", () => {
      expect(parseDate("just posted", fixedNow)).toBe(fixedNow.toISOString());
      expect(parseDate("moments ago", fixedNow)).toBe(fixedNow.toISOString());
      expect(parseDate("new", fixedNow)).toBe(fixedNow.toISOString());
      expect(parseDate("today", fixedNow)).toBe(fixedNow.toISOString());
      expect(parseDate("active today", fixedNow)).toBe(fixedNow.toISOString());
      expect(parseDate("hiring now", fixedNow)).toBe(fixedNow.toISOString());
    });

    it("parses 'yesterday' as now minus 1 day", () => {
      const yesterday = new Date(fixedNow.getTime() - 86400000).toISOString();
      expect(parseDate("yesterday", fixedNow)).toBe(yesterday);
      expect(parseDate("Posted Yesterday", fixedNow)).toBe(yesterday);
    });

    it("parses relative times with various units", () => {
      // 3 days ago
      const threeDays = new Date(fixedNow.getTime() - 3 * 86400000).toISOString();
      expect(parseDate("3 days ago", fixedNow)).toBe(threeDays);
      expect(parseDate("posted 3d ago", fixedNow)).toBe(threeDays);
      expect(parseDate("3d", fixedNow)).toBe(threeDays);

      // 2 hours ago
      const twoHours = new Date(fixedNow.getTime() - 2 * 3600000).toISOString();
      expect(parseDate("2 hours ago", fixedNow)).toBe(twoHours);
      expect(parseDate("2h ago", fixedNow)).toBe(twoHours);
      expect(parseDate("2h", fixedNow)).toBe(twoHours);

      // 30 minutes ago
      const thirtyMins = new Date(fixedNow.getTime() - 30 * 60000).toISOString();
      expect(parseDate("30 minutes ago", fixedNow)).toBe(thirtyMins);
      expect(parseDate("30m ago", fixedNow)).toBe(thirtyMins);

      // 45 seconds ago
      const fortyFiveSec = new Date(fixedNow.getTime() - 45 * 1000).toISOString();
      expect(parseDate("45 seconds ago", fixedNow)).toBe(fortyFiveSec);

      // 2 weeks ago
      const twoWeeks = new Date(fixedNow.getTime() - 2 * 7 * 86400000).toISOString();
      expect(parseDate("2 weeks ago", fixedNow)).toBe(twoWeeks);
      expect(parseDate("2w ago", fixedNow)).toBe(twoWeeks);

      // 1 month ago
      const oneMonth = new Date(fixedNow.getTime() - 1 * 30 * 86400000).toISOString();
      expect(parseDate("1 month ago", fixedNow)).toBe(oneMonth);
      expect(parseDate("1mo ago", fixedNow)).toBe(oneMonth);

      // 1 year ago
      const oneYear = new Date(fixedNow.getTime() - 1 * 365 * 86400000).toISOString();
      expect(parseDate("1 year ago", fixedNow)).toBe(oneYear);
      expect(parseDate("1y ago", fixedNow)).toBe(oneYear);

      // 30+ days ago
      const thirtyDays = new Date(fixedNow.getTime() - 30 * 86400000).toISOString();
      expect(parseDate("30+ days ago", fixedNow)).toBe(thirtyDays);
    });

    it("parses absolute date strings with prefixes", () => {
      const iso = "2026-04-10T08:30:00.000Z";
      expect(parseDate("2026-04-10T08:30:00.000Z", fixedNow)).toBe(iso);
      expect(parseDate("Posted on 2026-04-10T08:30:00.000Z", fixedNow)).toBe(iso);
      expect(parseDate("Published: 2026-04-10T08:30:00.000Z", fixedNow)).toBe(iso);
      expect(parseDate("Date Posted 2026-04-10T08:30:00.000Z", fixedNow)).toBe(iso);
    });

    it("returns null for dates before year 2000 or unparseable text", () => {
      expect(parseDate("1995-05-12", fixedNow)).toBeNull();
      expect(parseDate("not a date string", fixedNow)).toBeNull();
    });
  });

  describe("daysAgo", () => {
    it("returns null for null, undefined, or invalid ISO string", () => {
      expect(daysAgo(null, fixedNow)).toBeNull();
      expect(daysAgo("not-a-date", fixedNow)).toBeNull();
    });

    it("calculates positive fractional days ago", () => {
      const twoDaysAgoStr = new Date(fixedNow.getTime() - 2 * 86400000).toISOString();
      expect(daysAgo(twoDaysAgoStr, fixedNow)).toBeCloseTo(2, 5);

      const twelveHoursAgoStr = new Date(fixedNow.getTime() - 12 * 3600000).toISOString();
      expect(daysAgo(twelveHoursAgoStr, fixedNow)).toBeCloseTo(0.5, 5);
    });

    it("clamps future dates to 0", () => {
      const futureStr = new Date(fixedNow.getTime() + 86400000).toISOString();
      expect(daysAgo(futureStr, fixedNow)).toBe(0);
    });
  });

  describe("bucket", () => {
    const buckets = [1, 3, 7, 14, 30] as const;

    it("returns the smallest bucket that covers the given days", () => {
      expect(bucket(0.5, buckets)).toBe(1);
      expect(bucket(1, buckets)).toBe(1);
      expect(bucket(2, buckets)).toBe(3);
      expect(bucket(3, buckets)).toBe(3);
      expect(bucket(5, buckets)).toBe(7);
      expect(bucket(7, buckets)).toBe(7);
      expect(bucket(10, buckets)).toBe(14);
      expect(bucket(20, buckets)).toBe(30);
      expect(bucket(30, buckets)).toBe(30);
    });

    it("returns the largest bucket when days exceed all buckets", () => {
      expect(bucket(45, buckets)).toBe(30);
      expect(bucket(100, buckets)).toBe(30);
    });

    it("works correctly with unsorted bucket arrays", () => {
      const unsorted = [30, 7, 1, 14, 3] as const;
      expect(bucket(2, unsorted)).toBe(3);
      expect(bucket(50, unsorted)).toBe(30);
    });
  });
});
