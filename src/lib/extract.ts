/**
 * Tolerant field access. Actor output schemas drift, so every adapter asks
 * for a list of candidate paths and takes the first non-empty hit.
 */
export type Item = Record<string, unknown>;

export function get(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const isBlank = (v: unknown) =>
  v == null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);

export function first(obj: unknown, ...paths: string[]): unknown {
  for (const p of paths) {
    const v = get(obj, p);
    if (!isBlank(v)) return v;
  }
  return undefined;
}

export function str(obj: unknown, ...paths: string[]): string | null {
  const v = first(obj, ...paths);
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(", ") || null;
  if (typeof v === "object") {
    // Common shapes: { name }, { text }, { title }, { city, state }
    const o = v as Item;
    const named = str(o, "name", "text", "title", "label", "value", "formatted", "unknown");
    if (named) return named;
    const parts = [o.city, o.state ?? o.region, o.country].filter((x) => typeof x === "string" && x);
    return parts.length ? parts.join(", ") : null;
  }
  return null;
}

export function num(obj: unknown, ...paths: string[]): number | null {
  const v = first(obj, ...paths);
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) && v.match(/\d/) ? n : null;
  }
  return null;
}

export function bool(obj: unknown, ...paths: string[]): boolean | null {
  const v = first(obj, ...paths);
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|yes|1)$/i.test(v) ? true : /^(false|no|0)$/i.test(v) ? false : null;
  return null;
}

export function strArray(obj: unknown, ...paths: string[]): string[] {
  const v = first(obj, ...paths);
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === "string" ? x : str(x, "name", "label", "title", "prettyName")))
      .filter((x): x is string => !!x && x.trim() !== "")
      .map((x) => x.trim());
  }
  if (typeof v === "string") return v.split(/[,|;]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export function stripHtml(html: string | null): string | null {
  if (!html) return null;
  return (
    html
      .replace(/<(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, "\n\n")
      .trim() || null
  );
}

export function absUrl(u: string | null, base: string): string | null {
  if (!u) return null;
  try {
    return new URL(u, base).toString();
  } catch {
    return null;
  }
}
