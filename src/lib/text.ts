import { load } from "cheerio";
import type { EmploymentType, WorkMode } from "../model.ts";

/**
 * Strips HTML, converts block tags to newlines, decodes entities,
 * and normalizes whitespace while preserving readable structure.
 */
export function cleanHtml(html: string | null | undefined): string {
  if (!html) return "";
  if (!html.includes("<") && !html.includes("&")) return html.trim();

  // Replace block breaks before stripping to preserve paragraph structure
  const prepped = html
    .replace(/<\/(p|div|section|article|h[1-6]|tr|blockquote)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n\n");

  try {
    const $ = load(prepped);
    $("script, style, noscript, svg, iframe, template").remove();
    const text = $("body").length ? $("body").text() : $.root().text();
    return cleanText(decodeHtmlEntities(text));
  } catch {
    const fallback = prepped
      .replace(/<[^>]+>/g, "")
      .replace(/\r/g, "")
      .replace(/\n{3,}/g, "\n\n");
    return cleanText(decodeHtmlEntities(fallback));
  }
}

/**
 * Decode common and numeric HTML entities.
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = parseInt(code, 10);
      return Number.isNaN(n) ? "" : String.fromCharCode(n);
    })
    .replace(/&#x([a-f0-9]+);/gi, (_, hex) => {
      const n = parseInt(hex, 16);
      return Number.isNaN(n) ? "" : String.fromCharCode(n);
    });
}

export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const cleaned = cleanHtml(html);
  return cleaned || null;
}

/**
 * Clean markdown formatting into readable plain text.
 */
export function cleanMarkdown(md: string | null | undefined): string {
  if (!md) return "";
  return cleanText(
    md
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/\*([^*]+)\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/_([^_]+)_/g, "$1")
      .replace(/~~([^~]+)~~/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/^>\s+/gm, "")
      .replace(/^[-*+]\s+/gm, "• ")
      .replace(/^\d+\.\s+/gm, "")
      .replace(/^[-*_]{3,}\s*$/gm, "")
  );
}

/**
 * Normalize whitespace without destroying paragraph breaks.
 */
export function cleanText(text: string | null | undefined, maxLength?: number): string {
  if (!text) return "";
  let cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (maxLength && cleaned.length > maxLength) {
    cleaned = truncate(cleaned, maxLength);
  }
  return cleaned;
}

/**
 * Hard truncate with ellipsis.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
}

/**
 * Extract a search-card-friendly snippet from a long description.
 */
export function extractSnippet(text: string | null | undefined, maxLen = 220): string {
  if (!text) return "";
  const cleaned = cleanText(text).replace(/\s+/g, " ");
  if (cleaned.length <= maxLen) return cleaned;

  const chunk = cleaned.slice(0, maxLen);
  const lastDot = chunk.lastIndexOf(". ");
  if (lastDot > maxLen * 0.6) {
    return chunk.slice(0, lastDot + 1);
  }
  return truncate(chunk, maxLen);
}

export function extractExcerpt(text: string | null | undefined, maxChars = 300): string {
  return extractSnippet(text, maxChars);
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "our", "you",
  "your", "will", "have", "been", "all", "job", "role", "work", "team", "join",
]);

/**
 * Extract unique keywords/words for simple search / dedupe matching.
 */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9+#.-]{2,}/g) ?? []).filter(
    (w) => !STOP_WORDS.has(w)
  );
}

/**
 * Extract email addresses from text.
 */
export function extractEmails(text: string): string[] {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  return matches ? Array.from(new Set(matches.map((e) => e.toLowerCase()))) : [];
}

/**
 * Extract phone numbers.
 */
export function extractPhones(text: string): string[] {
  const matches = text.match(/(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g);
  return matches ? Array.from(new Set(matches.map((p) => p.trim()))) : [];
}

export const extractPhoneNumbers = extractPhones;

/**
 * Extract years of experience requirement.
 */
export function extractYearsOfExperience(text: string): { min: number; max: number | null } | null {
  const patterns = [
    /(\d+)\s*(?:to|-)\s*(\d+)\s*\+?\s*years?(?:\s+of)?(?:\s+experience)?/i,
    /(\d+)\s*\+\s*years?(?:\s+of)?(?:\s+experience)?/i,
    /(?:minimum|at least)\s*(\d+)\s*years?(?:\s+of)?(?:\s+experience)?/i,
    /(\d+)\s*years?(?:\s+of)?\s+(?:required|relevant)?\s*experience/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const min = parseInt(match[1]!, 10);
      const max = match[2] ? parseInt(match[2], 10) : null;
      if (!Number.isNaN(min) && min < 30) {
        return { min, max };
      }
    }
  }
  return null;
}

/**
 * Detect work arrangement / location type.
 */
export function detectWorkMode(...texts: (string | null | undefined | boolean)[]): WorkMode | null {
  if (texts.includes(true)) return "remote";
  const t = texts.filter((x) => typeof x === "string").join(" ").toLowerCase();
  if (!t) return null;
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(remote|work from home|wfh|telecommute|anywhere|distributed)\b/.test(t)) return "remote";
  if (/\b(on-?site|in-?office|in person)\b/.test(t)) return "onsite";
  return null;
}

export const detectLocationType = detectWorkMode;

/**
 * Detect employment type from text.
 */
export function detectEmploymentType(...texts: (string | null | undefined)[]): EmploymentType | null {
  const t = texts.filter(Boolean).join(" ").toLowerCase().replace(/[_-]/g, " ");
  if (!t) return null;
  if (/\bintern(ship)?\b/.test(t)) return "internship";
  if (/\bfreelance|hourly|fixed price|fixed\b/.test(t)) return "freelance";
  if (/\bcontract(or)?|c2c|1099|corp to corp\b/.test(t)) return "contract";
  if (/\btemp(orary)?\b|seasonal/.test(t)) return "temporary";
  if (/\bpart[- ]time\b/.test(t)) return "part_time";
  if (/\bfull[- ]time\b|permanent|regular|direct[- ]hire/.test(t)) return "full_time";
  return null;
}

const COMPANY_SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|gmbh|sa|ag|holdings|group|the)\b\.?/g;
const TITLE_NOISE = /\b(sr|senior|jr|junior|i{1,3}|iv|lead|staff|principal)\b\.?/g;

export function normCompany(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/&/g, "and").replace(COMPANY_SUFFIX, "").replace(/[^a-z0-9]+/g, "");
}

/**
 * Keeps seniority words: "Senior Engineer" and "Engineer" are distinct.
 */
export function normTitle(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/\s+-\s+.*$/, "")
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
  const city = s.split(/[,(|/\u2022\u00b7\u2013\u2014•·–—]/)[0] ?? "";
  return city.toLowerCase().replace(/\b(greater|metro|area|region)\b/g, "").replace(/[^a-z]+/g, "");
}

export function slug(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export const slugify = slug;

/**
 * FNV-1a 32-bit hash returning base36 string.
 */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Compute Jaccard similarity between two token sets.
 */
export function textSimilarity(a: string, b: string): number {
  const tokensA = new Set(words(a));
  const tokensB = new Set(words(b));
  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
