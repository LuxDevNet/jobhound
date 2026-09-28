import type { EmploymentType, WorkMode } from "../model.ts";

export function detectWorkMode(...texts: (string | null | undefined | boolean)[]): WorkMode | null {
  const t = texts.filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (texts.includes(true)) return "remote";
  if (!t) return null;
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(remote|work from home|wfh|telecommute|anywhere)\b/.test(t)) return "remote";
  if (/\b(on-?site|in-?office|in person)\b/.test(t)) return "onsite";
  return null;
}

export function detectEmploymentType(...texts: (string | null | undefined)[]): EmploymentType | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase().replace(/[_-]/g, " ");
  if (!t) return null;
  if (/\bintern(ship)?\b/.test(t)) return "internship";
  if (/\bfreelance|hourly|fixed price|fixed\b/.test(t)) return "freelance";
  if (/\bcontract(or)?|c2c|1099|corp to corp\b/.test(t)) return "contract";
  if (/\btemp(orary)?\b|seasonal/.test(t)) return "temporary";
  if (/\bpart time\b/.test(t)) return "part_time";
  if (/\bfull time\b|permanent|regular/.test(t)) return "full_time";
  return null;
}

const COMPANY_SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|sa|ag|holdings|group|the)\b\.?/g;
const TITLE_NOISE = /\b(sr|senior|jr|junior|i{1,3}|iv|lead|staff|principal)\b\.?/g;

export function normCompany(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/&/g, "and").replace(COMPANY_SUFFIX, "").replace(/[^a-z0-9]+/g, "");
}

/** Keeps seniority words: "Senior Engineer" and "Engineer" are different jobs. */
export function normTitle(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\s+-\s+.*$/, "") // "Engineer - Remote" -> "Engineer"
    .replace(/\bsr\b\.?/g, "senior")
    .replace(/\bjr\b\.?/g, "junior")
    .replace(/\beng\b/g, "engineer")
    .replace(/[^a-z0-9]+/g, "");
}

export function normTitleLoose(s: string | null | undefined): string {
  return normTitle((s ?? "").toLowerCase().replace(TITLE_NOISE, ""));
}

export function normCity(s: string | null | undefined): string {
  if (!s) return "";
  const city = s.split(/[,(|•·]/)[0] ?? "";
  return city.toLowerCase().replace(/\b(greater|metro|area|region)\b/g, "").replace(/[^a-z]+/g, "");
}

export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Tiny stable hash (FNV-1a, base36). Good enough for fingerprints. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
