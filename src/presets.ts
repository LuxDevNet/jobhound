import { promises as fs } from "node:fs";
import path from "node:path";
import type { Input } from "./input.ts";

export interface Preset {
  name: string;
  description: string;
  config: Partial<Input>;
}

export const BUILTIN_PRESETS: Record<string, Preset> = {
  "san-diego-120k": {
    name: "san-diego-120k",
    description: "Software Engineer jobs in San Diego (50mi radius) paying $120k+ / yr",
    config: {
      keywords: "software engineer",
      location: "San Diego, CA",
      radiusMiles: 50,
      minSalary: 120000,
      postedWithinDays: 14,
      sources: ["linkedin", "indeed", "glassdoor", "wellfound", "dice", "builtin"],
      keepUnknownSalary: false,
    },
  },
  "remote-staff-eng": {
    name: "remote-staff-eng",
    description: "Staff & Principal level remote roles paying $160k+",
    config: {
      keywords: "staff engineer OR principal engineer",
      location: "Remote",
      remoteOnly: true,
      minSalary: 160000,
      postedWithinDays: 7,
      titleInclude: ["staff", "principal", "lead", "architect"],
      sources: ["linkedin", "indeed", "wellfound", "himalayas", "remoteok", "weworkremotely", "hackernews"],
    },
  },
  "ai-ml-engineer": {
    name: "ai-ml-engineer",
    description: "AI, Machine Learning, and LLM Engineering positions",
    config: {
      keywords: "machine learning engineer OR AI engineer OR LLM",
      location: "United States",
      remoteOnly: false,
      minSalary: 130000,
      postedWithinDays: 14,
      companyBoards: [
        "greenhouse:openai",
        "lever:anthropic",
        "greenhouse:scaleai",
        "ashby:mistral",
        "greenhouse:cohere",
      ],
      sources: ["linkedin", "indeed", "wellfound", "hackernews", "builtin", "greenhouse", "lever", "ashby"],
    },
  },
  "frontend-react": {
    name: "frontend-react",
    description: "Frontend Engineer (React / TypeScript / Next.js)",
    config: {
      keywords: "frontend engineer react typescript",
      location: "Remote",
      remoteOnly: true,
      minSalary: 110000,
      postedWithinDays: 14,
      sources: ["linkedin", "indeed", "wellfound", "remoteok", "remotive", "himalayas", "dice"],
    },
  },
  "top-tech-ats": {
    name: "top-tech-ats",
    description: "Direct ATS company boards (Stripe, OpenAI, Palantir, Figma, Ramp, Airbnb)",
    config: {
      companyBoards: [
        "greenhouse:stripe",
        "greenhouse:openai",
        "lever:palantir",
        "greenhouse:figma",
        "ashby:ramp",
        "greenhouse:airbnb",
        "greenhouse:datadog",
        "greenhouse:vercel",
      ],
      sources: ["greenhouse", "lever", "ashby"],
      maxResultsPerSource: 200,
    },
  },
};

/**
 * Load a preset by name (built-in or from the searches/ directory).
 */
export async function loadPreset(name: string, customDir?: string): Promise<Preset | null> {
  const normalized = name.toLowerCase().replace(/\.json$/, "");
  if (BUILTIN_PRESETS[normalized]) {
    return BUILTIN_PRESETS[normalized]!;
  }

  const dir = customDir || path.resolve(process.cwd(), "searches");
  const filePath = path.join(dir, `${normalized}.json`);

  try {
    const data = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(data);
    return {
      name: normalized,
      description: parsed.description || `Custom search preset: ${normalized}`,
      config: parsed,
    };
  } catch {
    return null;
  }
}

/**
 * Save a search configuration as a preset in searches/<name>.json.
 */
export async function savePreset(name: string, config: Partial<Input>, description?: string): Promise<string> {
  const dir = path.resolve(process.cwd(), "searches");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${name.toLowerCase()}.json`);

  const payload = {
    name,
    description: description || `Saved search preset ${name}`,
    ...config,
  };

  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf-8");
  return filePath;
}

/**
 * List all available presets (built-in and on disk).
 */
export async function listAllPresets(customDir?: string): Promise<Preset[]> {
  const presets: Preset[] = Object.values(BUILTIN_PRESETS);
  const dir = customDir || path.resolve(process.cwd(), "searches");

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const p = await loadPreset(file, dir);
        if (p && !BUILTIN_PRESETS[p.name]) {
          presets.push(p);
        }
      }
    }
  } catch {}

  return presets;
}
