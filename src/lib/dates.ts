/**
 * Date parsing and normalization utilities.
 */

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

/**
 * Parses relative time strings (e.g., "3 days ago", "30m ago", "just posted", "yesterday").
 */
export function relativeToIso(text: string, now: Date = new Date()): string | null {
  const s = text.trim();
  if (!s) return null;
  const lower = s.toLowerCase();

  if (/(just|moments?)\s*(posted|ago)|^new$|^today|active today|hiring now/i.test(lower)) {
    return now.toISOString();
  }

  if (/yesterday/i.test(lower)) {
    return new Date(now.getTime() - UNIT_MS.d!).toISOString();
  }

  if (/\+?30\+?\s*days?\s*ago/i.test(lower)) {
    return new Date(now.getTime() - 30 * UNIT_MS.d!).toISOString();
  }

  // Check explicit relative patterns with quantities
  const relMatch = lower.match(
    /(?:posted|active|published)?\s*:?\s*(\d+)\s*\+?\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|hour|days?|d|day|weeks?|w|wk|week|months?|mo|mon|month|years?|y|yr|year)\s*(?:ago)?\b/i
  );

  if (relMatch) {
    const count = parseInt(relMatch[1]!, 10);
    const unit = relMatch[2]!.toLowerCase();

    if (unit.startsWith("sec") || unit === "s") {
      return new Date(now.getTime() - count * UNIT_MS.s!).toISOString();
    }
    if (unit.startsWith("min") || unit === "m") {
      return new Date(now.getTime() - count * UNIT_MS.m!).toISOString();
    }
    if (unit.startsWith("h")) {
      return new Date(now.getTime() - count * UNIT_MS.h!).toISOString();
    }
    if (unit.startsWith("d")) {
      return new Date(now.getTime() - count * UNIT_MS.d!).toISOString();
    }
    if (unit.startsWith("w")) {
      return new Date(now.getTime() - count * UNIT_MS.w!).toISOString();
    }
    if (unit.startsWith("mo") || unit.startsWith("mon")) {
      return new Date(now.getTime() - count * UNIT_MS.mo!).toISOString();
    }
    if (unit.startsWith("y")) {
      return new Date(now.getTime() - count * UNIT_MS.y!).toISOString();
    }
  }

  return null;
}

export function parseIsoDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Bare date "2026-03-15"
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const year = parseInt(trimmed.slice(0, 4), 10);
    if (year < 2000) return null;
    return `${trimmed}T00:00:00.000Z`;
  }

  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return null;
  return d.toISOString();
}

/**
 * Universal date parser for job postings.
 * Accepts ISO timestamps, epoch seconds/ms, relative strings, Date objects, or strings with prefixes.
 */
export function parseDate(value: unknown, now: Date = new Date()): string | null {
  if (value == null || value === "") return null;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return null;
    return d.toISOString();
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()) || value.getUTCFullYear() < 2000) return null;
    return value.toISOString();
  }

  if (typeof value !== "string") return null;

  const s = value.trim();
  if (!s) return null;

  // Epoch numeric string (10-13 digits)
  if (/^\d{10,13}$/.test(s)) {
    return parseDate(Number(s), now);
  }

  // Relative dates
  const relIso = relativeToIso(s, now);
  if (relIso) return relIso;

  // Strip prefixes like "Posted on ", "Published: ", "Date Posted ", "Active: "
  const cleaned = s.replace(/^(posted|date posted|published|active)\s*(on)?\s*:?\s*/i, "").trim();

  const iso = parseIsoDate(cleaned);
  if (iso) return iso;

  return null;
}

/**
 * Compute fractional days elapsed between an ISO date string and `now`.
 * Returns null if unparseable, clamps future dates to 0.
 */
export function daysAgo(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now.getTime() - t) / UNIT_MS.d!);
}

/**
 * Check if a date string is within the last N days.
 */
export function isWithinDays(dateStr: string | null | undefined, days: number, now: Date = new Date()): boolean {
  const elapsed = daysAgo(dateStr, now);
  if (elapsed == null) return false;
  return elapsed <= days;
}

/**
 * Smallest bucket that still covers `days`, or largest bucket if exceeding all.
 */
export function bucket<T extends number>(days: number, buckets: readonly T[]): T {
  const sorted = [...buckets].sort((a, b) => a - b);
  return sorted.find((b) => b >= days) ?? sorted[sorted.length - 1]!;
}
