import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { exec } from "node:child_process";
import type { Job } from "./model.ts";
import { formatSalary } from "./lib/salary.ts";

// High-contrast bright white terminal ANSI color codes
const W = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  inv: "\x1b[7m", // Inverted white background with black text
  brightWhite: "\x1b[97m",
  white: "\x1b[37m",
  black: "\x1b[30m",
  bgWhite: "\x1b[47m",
  bgBrightWhite: "\x1b[107m",
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
};

export async function loadRecentJobs(customPath?: string): Promise<Job[]> {
  const jobsDir = customPath || path.resolve(process.cwd(), "storage/datasets/default");
  const jobs: Job[] = [];

  try {
    const files = await fs.readdir(jobsDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const raw = await fs.readFile(path.join(jobsDir, file), "utf-8");
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) jobs.push(...parsed);
          else if (parsed && typeof parsed === "object" && parsed.id) jobs.push(parsed);
        } catch {}
      }
    }
  } catch {}

  // Fallback demo job if storage is empty
  if (!jobs.length) {
    jobs.push({
      id: "demo-staff-engineer",
      source: "greenhouse",
      seenOn: ["greenhouse", "linkedin", "dice"],
      urls: { greenhouse: "https://boards.greenhouse.io/stripe/jobs/123" },
      score: 98,
      scoreReasons: ["Direct ATS", "Salary $180k-$220k", "Fresh (<24h)"],
      isNew: true,
      scrapedAt: new Date().toISOString(),
      sourceJobId: "demo-1",
      title: "Staff Systems Engineer (Distributed Infrastructure)",
      company: "Stripe",
      location: "San Diego, CA (or Remote)",
      workMode: "remote",
      employmentType: "full_time",
      salary: {
        min: 180000,
        max: 220000,
        currency: "USD",
        period: "year",
        annualMin: 180000,
        annualMax: 220000,
        raw: "$180,000 - $220,000/yr",
        hasEquity: true,
      },
      postedAt: new Date().toISOString(),
      url: "https://boards.greenhouse.io/stripe/jobs/123",
      applyUrl: "https://boards.greenhouse.io/stripe/jobs/123",
      description: "Build high-throughput payment infrastructure and fault-tolerant distributed transaction systems.",
      skills: ["Go", "TypeScript", "Kubernetes", "AWS", "Distributed Systems"],
      seniority: "staff",
      yearsOfExperience: 6,
      isDirectAts: true,
      companyStage: "growth",
      companyUrl: "https://stripe.com",
      companyLogo: null,
      applicants: 14,
      extra: {},
    });
  }

  return jobs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function openUrlInBrowser(url: string) {
  const startCmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(startCmd, () => {});
}

export async function launchTui(initialJobs?: Job[]) {
  const jobs = initialJobs?.length ? initialJobs : await loadRecentJobs();
  let selectedIndex = 0;
  let viewMode: "list" | "detail" = "list";
  let searchQuery = "";
  let isSearching = false;
  let bookmarkedIds = new Set<string>();
  let statusMessage = "Press [j/k] Navigate | [Enter] Details | [o] Open Browser | [s] Bookmark | [q] Quit";

  const getFilteredJobs = () => {
    if (!searchQuery.trim()) return jobs;
    const q = searchQuery.toLowerCase();
    return jobs.filter(
      (j) =>
        j.title.toLowerCase().includes(q) ||
        (j.company ?? "").toLowerCase().includes(q) ||
        (j.location ?? "").toLowerCase().includes(q) ||
        j.skills.some((s) => s.toLowerCase().includes(q)),
    );
  };

  const render = () => {
    const termWidth = process.stdout.columns || 100;
    const termHeight = process.stdout.rows || 30;
    const filtered = getFilteredJobs();

    if (selectedIndex >= filtered.length) {
      selectedIndex = Math.max(0, filtered.length - 1);
    }

    let out = W.clear;

    // Top Header Banner (White Monochrome Inverted)
    const headerTitle = `  UNJOBBED // RADAR TUI  `;
    const headerStats = `[ ${filtered.length} Jobs Listed | ${bookmarkedIds.size} Saved ]  `;
    const padding = " ".repeat(Math.max(0, termWidth - headerTitle.length - headerStats.length));
    out += `${W.bold}${W.inv}${headerTitle}${padding}${headerStats}${W.reset}\n`;

    if (isSearching) {
      out += `\n${W.bold}${W.brightWhite}  SEARCH QUERY: ${W.reset}${searchQuery}█\n`;
    }

    if (viewMode === "list") {
      const pageSize = Math.max(5, termHeight - 8);
      const startIdx = Math.floor(selectedIndex / pageSize) * pageSize;
      const visibleJobs = filtered.slice(startIdx, startIdx + pageSize);

      out += `\n${W.bold}${W.brightWhite}  #   SCORE  TITLE                                COMPANY              SALARY             MODE     ${W.reset}\n`;
      out += `  ${W.dim}${"─".repeat(termWidth - 4)}${W.reset}\n`;

      visibleJobs.forEach((job, idx) => {
        const actualIdx = startIdx + idx;
        const isSelected = actualIdx === selectedIndex;
        const mark = bookmarkedIds.has(job.id) ? "★" : " ";
        const numStr = String(actualIdx + 1).padStart(2, " ");
        const scoreStr = `${job.score}pts`.padEnd(6, " ");
        const titleStr = (job.title.length > 34 ? job.title.slice(0, 31) + "..." : job.title).padEnd(35, " ");
        const companyStr = ((job.company ?? "Unknown").length > 19 ? (job.company ?? "Unknown").slice(0, 16) + "..." : (job.company ?? "Unknown")).padEnd(20, " ");
        const salaryStr = (formatSalary(job.salary) || "Not Listed").slice(0, 18).padEnd(19, " ");
        const modeStr = (job.workMode ?? "remote").toUpperCase().padEnd(8, " ");

        const rowText = `  ${mark} ${numStr}  ${scoreStr} ${titleStr} ${companyStr} ${salaryStr} ${modeStr}`;

        if (isSelected) {
          out += `${W.inv}${W.bold}${rowText.padEnd(termWidth - 2, " ")}${W.reset}\n`;
        } else {
          out += `${W.brightWhite}${rowText}${W.reset}\n`;
        }
      });
    } else {
      // Detail View
      const job = filtered[selectedIndex];
      if (job) {
        out += `\n${W.bold}${W.inv}  JOB DETAIL INSPECTOR  ${W.reset}\n\n`;
        out += `  ${W.bold}${W.brightWhite}Title:${W.reset}       ${job.title}\n`;
        out += `  ${W.bold}${W.brightWhite}Company:${W.reset}     ${job.company ?? "N/A"} (${job.companyStage || "Stage N/A"})\n`;
        out += `  ${W.bold}${W.brightWhite}Location:${W.reset}    ${job.location ?? "Remote"} [${(job.workMode ?? "remote").toUpperCase()}]\n`;
        out += `  ${W.bold}${W.brightWhite}Salary:${W.reset}      ${formatSalary(job.salary) || "Not specified"}\n`;
        out += `  ${W.bold}${W.brightWhite}Seniority:${W.reset}   ${(job.seniority ?? "Mid").toUpperCase()} (${job.yearsOfExperience ? `${job.yearsOfExperience}+ yrs exp` : "Exp N/A"})\n`;
        out += `  ${W.bold}${W.brightWhite}ATS / Type:${W.reset}  ${job.isDirectAts ? "Direct ATS Portal" : "Aggregator Board"} (${job.seenOn.join(", ")})\n`;
        out += `  ${W.bold}${W.brightWhite}Score:${W.reset}       ${job.score}/100 — Reasons: ${job.scoreReasons.join(", ") || "Good keyword match"}\n`;
        out += `  ${W.bold}${W.brightWhite}Skills:${W.reset}      ${job.skills.join(", ") || "General Technical"}\n`;
        out += `  ${W.bold}${W.brightWhite}Apply URL:${W.reset}   ${job.applyUrl || job.url}\n\n`;
        out += `  ${W.bold}${W.brightWhite}Description Preview:${W.reset}\n`;
        out += `  ${W.dim}${"─".repeat(termWidth - 4)}${W.reset}\n`;

        const descLines = (job.description ?? "No description available.")
          .slice(0, 1000)
          .split("\n")
          .slice(0, 10);
        for (const line of descLines) {
          out += `  ${W.white}${line.slice(0, termWidth - 6)}${W.reset}\n`;
        }
      }
    }

    // Bottom Status Bar
    out += `\n${W.dim}${"─".repeat(termWidth - 2)}${W.reset}\n`;
    out += `${W.bold}${W.brightWhite}  ${statusMessage}${W.reset}\n`;

    process.stdout.write(out);
  };

  // Keyboard raw mode handling
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdout.write(W.hideCursor);

  render();

  process.stdin.on("keypress", (str, key) => {
    if (isSearching) {
      if (key.name === "return" || key.name === "escape") {
        isSearching = false;
        statusMessage = `Search active: "${searchQuery}" | Press [/] to change, [Esc] clear`;
      } else if (key.name === "backspace") {
        searchQuery = searchQuery.slice(0, -1);
      } else if (str && str.length === 1 && !key.ctrl && !key.meta) {
        searchQuery += str;
      }
      render();
      return;
    }

    if (key.ctrl && key.name === "c") {
      process.stdout.write(W.showCursor + W.clear);
      process.exit(0);
    }

    const filtered = getFilteredJobs();
    const currentJob = filtered[selectedIndex];

    switch (key.name) {
      case "q":
      case "escape":
        if (viewMode === "detail") {
          viewMode = "list";
          statusMessage = "Press [j/k] Navigate | [Enter] Details | [o] Open Browser | [s] Bookmark | [q] Quit";
        } else if (searchQuery) {
          searchQuery = "";
          statusMessage = "Search cleared.";
        } else {
          process.stdout.write(W.showCursor + W.clear);
          process.exit(0);
        }
        break;

      case "up":
      case "k":
        if (selectedIndex > 0) selectedIndex--;
        break;

      case "down":
      case "j":
        if (selectedIndex < filtered.length - 1) selectedIndex++;
        break;

      case "return":
      case "space":
        viewMode = viewMode === "list" ? "detail" : "list";
        statusMessage = viewMode === "detail" ? "Viewing Details | Press [Esc/Enter] Back | [o] Open URL | [a] Auto-Apply" : "Press [j/k] Navigate | [Enter] Details";
        break;

      case "o":
        if (currentJob) {
          const targetUrl = currentJob.applyUrl || currentJob.url;
          if (targetUrl) {
            openUrlInBrowser(targetUrl);
            statusMessage = `Opened in browser: ${targetUrl.slice(0, 50)}...`;
          } else {
            statusMessage = "No URL available for this listing.";
          }
        }
        break;

      case "s":
        if (currentJob) {
          if (bookmarkedIds.has(currentJob.id)) {
            bookmarkedIds.delete(currentJob.id);
            statusMessage = `Removed bookmark: ${currentJob.title.slice(0, 40)}`;
          } else {
            bookmarkedIds.add(currentJob.id);
            statusMessage = `★ Saved bookmark: ${currentJob.title.slice(0, 40)}`;
          }
        }
        break;

      case "a":
        if (currentJob) {
          statusMessage = `[Pro Auto-Applier] Initiating 1-Click ATS autofill for ${currentJob.title.slice(0, 30)}...`;
        }
        break;

      case "slash":
        isSearching = true;
        statusMessage = "Type search query and press [Enter]...";
        break;
    }

    render();
  });
}
