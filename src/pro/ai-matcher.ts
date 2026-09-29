import type { Job } from "../model.ts";
import { textSimilarity, words } from "../lib/text.ts";

export interface CandidateProfile {
  name: string;
  email: string;
  phone?: string;
  location?: string;
  title?: string;
  summary?: string;
  skills: string[];
  experienceYears?: number;
  experiences?: {
    role: string;
    company: string;
    description: string;
    skills?: string[];
  }[];
  links?: {
    linkedin?: string;
    github?: string;
    portfolio?: string;
  };
}

export interface MatchResult {
  jobId: string;
  matchScore: number; // 0 - 100
  matchingSkills: string[];
  missingSkills: string[];
  experienceFit: boolean;
  tailoredSummary: string;
  suggestedCoverLetter: string;
}

/**
 * Evaluates semantic and keyword alignment between a job posting and a candidate profile.
 */
export function evaluateJobMatch(job: Job, profile: CandidateProfile): MatchResult {
  const jobText = `${job.title} ${job.description ?? ""} ${job.skills.join(" ")}`.toLowerCase();
  const profileText = `${profile.title ?? ""} ${profile.summary ?? ""} ${profile.skills.join(" ")} ${(profile.experiences ?? []).map((e) => `${e.role} ${e.description}`).join(" ")}`.toLowerCase();

  // 1. Skill overlap
  const profileSkillsSet = new Set(profile.skills.map((s) => s.toLowerCase()));
  const matchingSkills: string[] = [];
  const missingSkills: string[] = [];

  for (const sk of job.skills) {
    const skLower = sk.toLowerCase();
    if (profileSkillsSet.has(skLower) || jobText.includes(skLower)) {
      if (profileText.includes(skLower)) matchingSkills.push(sk);
      else missingSkills.push(sk);
    }
  }

  // 2. Experience level alignment
  let experienceFit = true;
  if (job.yearsOfExperience != null && profile.experienceYears != null) {
    experienceFit = profile.experienceYears >= job.yearsOfExperience;
  }

  // 3. Jaccard & keyword scoring
  const similarity = textSimilarity(jobText, profileText);
  let score = Math.round(similarity * 50);

  // Skill match bonus
  if (matchingSkills.length) {
    const skillRatio = matchingSkills.length / Math.max(1, matchingSkills.length + missingSkills.length);
    score += Math.round(skillRatio * 35);
  } else {
    score += 15;
  }

  // Experience fit bonus
  if (experienceFit) score += 15;

  const matchScore = Math.min(100, Math.max(10, score));

  // Generate tailored cover letter / application pitch
  const topSkills = matchingSkills.slice(0, 4).join(", ") || profile.skills.slice(0, 4).join(", ");
  const tailoredSummary = `Matched ${matchScore}% with ${matchingSkills.length} key skill overlaps (${topSkills}).`;

  const suggestedCoverLetter = `Dear Hiring Team at ${job.company || "the company"},

I am writing to express my strong interest in the ${job.title} role. With a background in ${profile.title || "software engineering"} and proven experience in ${topSkills}, I am confident in my ability to make an immediate positive impact on your team.

Throughout my experience, I have developed expertise in building scalable, robust software solutions and delivering measurable results. The opportunity to contribute to ${job.company || "your organization"} aligns directly with my career trajectory.

I look forward to discussing how my technical background and problem-solving skills align with your current objectives.

Sincerely,
${profile.name}`;

  return {
    jobId: job.id,
    matchScore,
    matchingSkills,
    missingSkills,
    experienceFit,
    tailoredSummary,
    suggestedCoverLetter,
  };
}

/**
 * Score and rank an entire batch of jobs against a candidate profile.
 */
export function rankJobsByProfile(
  jobs: Job[],
  profile: CandidateProfile,
  minScore = 0,
): { job: Job; match: MatchResult }[] {
  return jobs
    .map((job) => ({
      job,
      match: evaluateJobMatch(job, profile),
    }))
    .filter((item) => item.match.matchScore >= minScore)
    .sort((a, b) => b.match.matchScore - a.match.matchScore);
}
