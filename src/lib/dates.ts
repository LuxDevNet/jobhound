const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
  mo: 30 * 86_400_000,
  y: 365 * 86_400_000,
};

function unitKey(u: string): keyof typeof UNIT_MS | null {
  const s = u.toLowerCase();
  if (s.startsWith("sec") || s === "s") return "s";
  if (s.startsWith("min") || s === "m") return "m";
  if (s.startsWith("h")) return "h";
  if (s.startsWith("d")) return "d";
  if (s.startsWith("w")) return "w";
  if (s.startsWith("mo")) return "mo";
  if (s.startsWith("y")) return "y";
  return null;
}

/**
 * Turn anything a job board calls a date into ISO-8601, or null.
 * Handles ISO strings, epoch seconds/ms, "3 days ago", "Posted 5d ago",
 * "30+ days ago", "Just posted", "Today", "Yesterday".
 */
export function parseDate(v: unknown, now: Date = new Date()): string | null {
  if (v == null || v === "") return null;

  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v !== "string") return null;

  const s = v.trim();
  if (/^\d{10,13}$/.test(s)) return parseDate(Number(s), now);

  const lower = s.toLowerCase();
  if (/(just|moments?)\s*(posted|ago)|^new$|^today|active today|hiring now/.test(lower)) return now.toISOString();
  if (/yesterday/.test(lower)) return new Date(now.getTime() - UNIT_MS.d!).toISOString();

  const rel = lower.match(/(\d+)\s*\+?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|w|months?|mo|years?|y)\b/);
  if (rel && (/ago|posted|active|\+/.test(lower) || /^\d+\s*[a-z]+$/.test(lower))) {
    const key = unitKey(rel[2]!);
    if (key) return new Date(now.getTime() - Number(rel[1]) * UNIT_MS[key]!).toISOString();
  }

  // Strip "Posted " / "Posted on" prefixes before a real date
  const cleaned = s.replace(/^(posted|date posted|published)\s*(on)?\s*:?\s*/i, "");
  const d = new Date(cleaned);
  if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2000) return d.toISOString();
  return null;
}

export function daysAgo(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, (now.getTime() - t) / UNIT_MS.d!);
}

/** Smallest bucket that still covers `days`, else the largest bucket. */
export function bucket<T extends number>(days: number, buckets: readonly T[]): T {
  const sorted = [...buckets].sort((a, b) => a - b);
  return sorted.find((b) => b >= days) ?? sorted[sorted.length - 1]!;
}
