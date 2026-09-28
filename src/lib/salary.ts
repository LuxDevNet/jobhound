import type { Salary } from "../model.ts";

export type SalaryPeriod = NonNullable<Salary["period"]>;

const PERIOD_PATTERNS: [RegExp, SalaryPeriod][] = [
  [/\b(hr|hour|hourly)\b|\/h(?:r)?\b|an hour|per hour|\/hour/i, "hour"],
  [/\b(day|daily)\b|per day|\/day/i, "day"],
  [/\b(week|weekly|wk)\b|per week|\/wk|\/week/i, "week"],
  [/\b(month|monthly|mo)\b|per month|\/mo|\/month/i, "month"],
  [/\b(year|yearly|annual|annually|yr|pa)\b|\bp\.a\.|\/yr|\/year|\/annum|per year|a year/i, "year"],
  [/\bfixed\b/i, "fixed"],
];

export const MULTIPLIER: Record<SalaryPeriod, number | null> = {
  hour: 2080,
  day: 260,
  week: 52,
  month: 12,
  year: 1,
  fixed: null,
};

const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/CA\$|\bCAD\b/i, "CAD"],
  [/A\$|\bAUD\b/i, "AUD"],
  [/US\$|\bUSD\b|\$/i, "USD"],
  [/€|\bEUR\b/i, "EUR"],
  [/£|\bGBP\b/i, "GBP"],
  [/₹|\bINR\b/i, "INR"],
  [/¥|\bJPY\b|\bCNY\b/i, "JPY"],
  [/\bCHF\b/i, "CHF"],
];

const RATES_TO_USD: Record<string, number> = {
  USD: 1.0,
  CAD: 0.74,
  EUR: 1.08,
  GBP: 1.27,
  AUD: 0.65,
  INR: 0.012,
  JPY: 0.0067,
  CHF: 1.15,
};

export function parsePeriod(text: string | null | undefined): SalaryPeriod | null {
  if (!text) return null;
  for (const [re, p] of PERIOD_PATTERNS) {
    if (re.test(text)) return p;
  }
  return null;
}

export function normalizePeriod(p: string | null | undefined): SalaryPeriod | null {
  if (!p) return null;
  const s = p.toLowerCase().trim();
  if (s.startsWith("hour") || s === "hr" || s === "hourly" || s === "/h" || s === "/hr") return "hour";
  if (s.startsWith("da")) return "day";
  if (s.startsWith("week") || s === "wk") return "week";
  if (s.startsWith("month") || s === "mo") return "month";
  if (s.startsWith("year") || s.startsWith("annual") || s === "yr" || s === "pa" || s === "p.a.") return "year";
  if (s.startsWith("fixed")) return "fixed";
  return parsePeriod(p);
}

function annualize(n: number | null, period: SalaryPeriod | null): number | null {
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
    if (Number.isFinite(n) && n > 0 && n < 100_000_000) out.push(n);
  }
  return out;
}

export interface SalaryParts {
  raw?: string | null;
  min?: number | null;
  max?: number | null;
  currency?: string | null;
  period?: string | null;
  hasEquity?: boolean | null;
}

export interface ParsedSalary extends Salary {
  interval?: SalaryPeriod | null;
}

/**
 * Build a Salary from whatever a board gives you: a free-text string,
 * explicit min/max numbers, or both. Returns null when there's nothing.
 */
export function buildSalary(parts: SalaryParts | string | null | undefined): Salary | null {
  if (parts == null) return null;
  const p: SalaryParts = typeof parts === "string" ? { raw: parts } : parts;
  const raw = p.raw?.trim() || null;

  const hasEquity = p.hasEquity ?? (raw ? /\b(equity|stock|rsu|rsus|options|shares)\b/i.test(raw) : false);

  let min = p.min ?? null;
  let max = p.max ?? null;

  // Google Jobs uses an en dash with a "K" on the second number only: "120–150K a year"
  if (raw && min == null && max == null) {
    const text = raw
      .replace(/(\d)\s*[–—\-]\s*(\d+(?:\.\d+)?)\s*([kKmM])/g, "$1$3 - $2$3")
      .replace(/(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)\s*([kKmM])/gi, "$1$3 - $2$3");
    const nums = extractAmounts(text);
    if (nums.length) {
      if (nums.length === 1) {
        if (/^\s*(up to|max(?:imum)?)\s+/i.test(raw)) {
          min = null;
          max = nums[0]!;
        } else if (/^\s*(starting at|from|min(?:imum)?)\s+/i.test(raw)) {
          min = nums[0]!;
          max = null;
        } else {
          min = nums[0]!;
          max = null;
        }
      } else {
        min = nums[0]!;
        max = nums[1]!;
      }
    }
  }

  if (min == null && max == null) {
    if (!raw) return null;
    const res: Salary = {
      min: null,
      max: null,
      currency: null,
      period: null,
      annualMin: null,
      annualMax: null,
      raw,
    };
    if (hasEquity) res.hasEquity = true;
    return res;
  }

  if (min != null && max != null && min > max) [min, max] = [max, min];

  const period = normalizePeriod(p.period) ?? parsePeriod(raw);
  let currency = p.currency?.toUpperCase() ?? null;
  if (!currency && raw) {
    for (const [re, c] of CURRENCY_SYMBOLS) {
      if (re.test(raw)) {
        currency = c;
        break;
      }
    }
  }

  const result: Salary = {
    min,
    max,
    currency,
    period,
    annualMin: annualize(min, period),
    annualMax: annualize(max ?? min, period),
    raw,
  };
  if (hasEquity) result.hasEquity = true;

  return result;
}

/**
 * Format salary for readable UI display.
 */
export function formatSalary(s: Salary | null): string {
  if (!s) return "";
  if (s.annualMin == null && s.annualMax == null) return s.raw ?? "";
  const k = (n: number | null) => (n == null ? "?" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const cur = s.currency === "USD" || !s.currency ? "$" : `${s.currency} `;
  const range = s.annualMin === s.annualMax || s.annualMax == null ? k(s.annualMin) : `${k(s.annualMin)}-${k(s.annualMax)}`;
  const equityBadge = s.hasEquity ? " + Equity" : "";
  return `${cur}${range}/yr${s.period && s.period !== "year" ? ` (from ${s.period})` : ""}${equityBadge}`;
}

/**
 * Normalize salary to annual USD equivalent using exchange rates.
 */
export function normalizeSalaryToAnnualUSD(
  parsed: Salary | null
): { min: number | null; max: number | null } {
  if (!parsed || parsed.annualMin === null) {
    return { min: null, max: null };
  }

  const rate = RATES_TO_USD[parsed.currency ?? "USD"] ?? 1.0;
  return {
    min: Math.round(parsed.annualMin * rate),
    max: parsed.annualMax !== null ? Math.round(parsed.annualMax * rate) : null,
  };
}

/** Alias for buildSalary with ParsedSalary compatibility */
export function parseSalary(text: string | null | undefined): ParsedSalary | null {
  const sal = buildSalary(text);
  if (!sal) return null;
  return {
    ...sal,
    interval: sal.period,
  };
}
