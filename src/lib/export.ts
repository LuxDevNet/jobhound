import { promises as fs } from "node:fs";
import path from "node:path";
import type { Job } from "../model.ts";

export function jobsToCsv(jobs: Job[]): string {
  const headers = [
    "id",
    "title",
    "company",
    "location",
    "workMode",
    "employmentType",
    "salaryAnnualMin",
    "salaryAnnualMax",
    "salaryPeriod",
    "salaryCurrency",
    "salaryRaw",
    "hasEquity",
    "postedAt",
    "url",
    "applyUrl",
    "score",
    "seenOn",
  ];

  const escapeCsv = (val: unknown): string => {
    if (val == null) return "";
    const str = Array.isArray(val) ? val.join(";") : String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = jobs.map((j) => [
    j.id,
    j.title,
    j.company ?? "",
    j.location ?? "",
    j.workMode ?? "",
    j.employmentType ?? "",
    j.salary?.annualMin ?? "",
    j.salary?.annualMax ?? "",
    j.salary?.period ?? "",
    j.salary?.currency ?? "",
    j.salary?.raw ?? "",
    j.salary?.hasEquity ? "true" : "false",
    j.postedAt ?? "",
    j.url,
    j.applyUrl ?? "",
    j.score ?? "",
    j.seenOn.join(";"),
  ]);

  return [headers.join(","), ...rows.map((r) => r.map(escapeCsv).join(","))].join("\n");
}

export function jobsToJsonl(jobs: Job[]): string {
  return jobs.map((j) => JSON.stringify(j)).join("\n");
}

export async function exportToFile(
  jobs: Job[],
  outputPath: string,
  format: "json" | "jsonl" | "csv" = "json",
): Promise<string> {
  const resolved = path.resolve(process.cwd(), outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });

  let content: string;
  if (format === "csv" || resolved.endsWith(".csv")) {
    content = jobsToCsv(jobs);
  } else if (format === "jsonl" || resolved.endsWith(".jsonl") || resolved.endsWith(".ndjson")) {
    content = jobsToJsonl(jobs);
  } else {
    content = JSON.stringify(jobs, null, 2);
  }

  await fs.writeFile(resolved, content, "utf-8");
  return resolved;
}

export async function sendWebhook(
  webhookUrl: string,
  payload: { summary: Record<string, unknown>; jobs: Job[] },
): Promise<{ success: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Jobhound-Webhook-Emitter/1.0",
      },
      body: JSON.stringify(payload),
    });

    return {
      success: res.ok,
      status: res.status,
      error: res.ok ? undefined : `HTTP ${res.status}: ${res.statusText}`,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}
