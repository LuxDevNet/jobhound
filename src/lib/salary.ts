import type { Salary } from "../model.ts";

type Period = NonNullable<Salary["period"]>;

const PERIOD_PATTERNS: [RegExp, Period][] = [
  [/\b(hr|hour|hourly|\/h)\b|an hour|per hour|\/hr/i, "hour"],
  [/\b(day|daily)\b|per day|\/day/i, "day"],
  [/\b(week|weekly|wk)\b|per week|\/wk/i, "week"],
  [/\b(month|monthly|mo)\b|per month|\/mo/i, "month"],
  [/\b(year|yearly|annual|annually|yr|pa|p\.a\.)\b|per year|a year|\/yr/i, "year"],
  [/\bfixed\b/i, "fixed"],
];

const MULTIPLIER: Record<Period, number | null> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
  fixed: null,
};

const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/US\$|USD|\$/, "USD"],
  [/€|EUR/, "EUR"],
  [/£|GBP/, "GBP"],
  [/CA\$|CAD/, "CAD"],
  [/A\$|AUD/, "AUD"],
  [/₹|INR/, "INR"],
];

export function parsePeriod(text: string | null | undefined): Period | null {
  if (!text) return null;
  for (const [re, p] of PERIOD_PATTERNS) if (re.test(text)) return p;
  return null;
}

export function normalizePeriod(p: string | null | undefined): Period | null {
  if (!p) return null;
  const s = p.toLowerCase();
  if (s.startsWith("hour") || s === "hr" || s === "hourly") return "hour";
  if (s.startsWith("da")) return "day";
  if (s.startsWith("week")) return "week";
  if (s.startsWith("month")) return "month";
  if (s.startsWith("year") || s.startsWith("annual") || s === "yr") return "year";
  if (s.startsWith("fixed")) return "fixed";
  return parsePeriod(p);
}

function annualize(n: number | null, period: Period | null): number | null {
  if (n == null) return null;
  // No period given: guess from magnitude (under 500 is almost always hourly).
  const p = period ?? (n < 500 ? "hour" : n < 20_000 ? "month" : "year");
  const m = MULTIPLIER[p];
  return m == null ? null : Math.round(n * m);
}

/** Pulls numbers like "120,000", "$120K", "1.2M", "55.50" out of free text. */
function extractAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /(\d{1,3}(?:[,\s]\d{3})+|\d+(?:\.\d+)?)\s*([kKmM])?(?![\d%])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let n = Number(m[1]!.replace(/[,\s]/g, ""));
    const suffix = m[2]?.toLowerCase();
    if (suffix === "k") n *= 1_000;
    if (suffix === "m") n *= 1_000_000;
    if (Number.isFinite(n) && n > 0) out.push(n);
  }
  return out;
}

export interface SalaryParts {
  raw?: string | null;
  min?: number | null;
  max?: number | null;
  currency?: string | null;
  period?: string | null;
}

/**
 * Build a Salary from whatever a board gives you: a free-text string,
 * explicit min/max numbers, or both. Returns null when there's nothing.
 */
export function buildSalary(parts: SalaryParts | string | null | undefined): Salary | null {
  if (parts == null) return null;
  const p: SalaryParts = typeof parts === "string" ? { raw: parts } : parts;
  const raw = p.raw?.trim() || null;

  let min = p.min ?? null;
  let max = p.max ?? null;
  // Google Jobs uses an en dash with a "K" on the second number only: "120–150K a year"
  if (raw && min == null && max == null) {
    const text = raw.replace(/(\d)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*([kKmM])/g, "$1$3 - $2$3");
    const nums = extractAmounts(text);
    if (nums.length) {
      min = nums[0]!;
      max = nums.length > 1 ? nums[1]! : null;
      if (/^\s*up to/i.test(raw)) [min, max] = [null, min];
    }
  }
  if (min == null && max == null) return raw ? { min: null, max: null, currency: null, period: null, annualMin: null, annualMax: null, raw } : null;
  if (min != null && max != null && min > max) [min, max] = [max, min];

  const period = normalizePeriod(p.period) ?? parsePeriod(raw);
  let currency = p.currency?.toUpperCase() ?? null;
  if (!currency && raw) {
    for (const [re, c] of CURRENCY_SYMBOLS) if (re.test(raw)) { currency = c; break; }
  }

  return {
    min,
    max,
    currency,
    period,
    annualMin: annualize(min, period),
    annualMax: annualize(max ?? min, period),
    raw,
  };
}

export function formatSalary(s: Salary | null): string {
  if (!s) return "";
  if (s.annualMin == null && s.annualMax == null) return s.raw ?? "";
  const k = (n: number | null) => (n == null ? "?" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const cur = s.currency === "USD" || !s.currency ? "$" : `${s.currency} `;
  const range = s.annualMin === s.annualMax || s.annualMax == null ? k(s.annualMin) : `${k(s.annualMin)}-${k(s.annualMax)}`;
  return `${cur}${range}/yr${s.period && s.period !== "year" ? ` (from ${s.period})` : ""}`;
}
