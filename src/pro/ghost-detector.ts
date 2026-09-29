import type { Job } from "../model.ts";
import { daysAgo } from "../lib/dates.ts";

export interface GhostScore {
  jobId: string;
  ghostProbability: number; // 0 (legit) to 100 (likely ghost)
  reasons: string[];
  isLikelyGhost: boolean;
}

const RECRUITER_KEYWORDS = [
  "our client",
  "confidential client",
  "stealth startup with massive funding",
  "staffing agency",
  "talent solutions",
  "recruiting partner",
  "leading client",
];

/**
 * Calculates ghost job probability based on age, generic descriptions, recruiter masking, and repost signals.
 */
export function analyzeGhostJob(job: Job): GhostScore {
  const reasons: string[] = [];
  let score = 0;

  const desc = (job.description ?? "").toLowerCase();
  const age = daysAgo(job.postedAt);

  // 1. Age Signal (>60 days old is frequently a perpetual listing)
  if (age != null && age > 60) {
    score += 40;
    reasons.push(`Stale posting (open for ${Math.round(age)} days)`);
  } else if (age != null && age > 35) {
    score += 20;
    reasons.push(`Aging listing (${Math.round(age)} days old)`);
  }

  // 2. Recruiter / Staffing agency blind masking
  for (const kw of RECRUITER_KEYWORDS) {
    if (desc.includes(kw)) {
      score += 25;
      reasons.push(`Staffing agency keyword detected ("${kw}")`);
      break;
    }
  }

  // 3. Ultra-short or placeholder description
  if (desc.length > 0 && desc.length < 200) {
    score += 25;
    reasons.push("Vague or placeholder job description (<200 chars)");
  }

  // 4. Missing company name
  if (!job.company || job.company.toLowerCase() === "confidential") {
    score += 30;
    reasons.push("Company identity is hidden/confidential");
  }

  // 5. Unrealistic salary range
  if (job.salary?.annualMin && job.salary?.annualMax) {
    const spread = job.salary.annualMax - job.salary.annualMin;
    if (spread > 150000) {
      score += 15;
      reasons.push("Suspiciously wide salary spread (>$150k delta)");
    }
  }

  const ghostProbability = Math.min(100, score);
  const isLikelyGhost = ghostProbability >= 50;

  return {
    jobId: job.id,
    ghostProbability,
    reasons,
    isLikelyGhost,
  };
}

/**
 * Filter a list of jobs to eliminate likely ghost postings.
 */
export function filterGhostJobs(jobs: Job[], maxGhostProbability = 49): Job[] {
  return jobs.filter((j) => {
    const analysis = analyzeGhostJob(j);
    return analysis.ghostProbability <= maxGhostProbability;
  });
}
