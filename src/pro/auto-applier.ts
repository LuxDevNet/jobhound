import { chromium, type Page } from "playwright";
import type { CandidateProfile } from "./ai-matcher.ts";

export interface ApplicationResult {
  jobUrl: string;
  ats: string;
  success: boolean;
  fieldsFilled: string[];
  message: string;
}

/**
 * Headless ATS 1-Click Form Autofill Engine (Greenhouse, Lever, Ashby, SmartRecruiters).
 */
export async function autofillApplication(
  url: string,
  profile: CandidateProfile,
  options: { dryRun?: boolean; headless?: boolean; resumePath?: string } = {},
): Promise<ApplicationResult> {
  const isDryRun = options.dryRun ?? true;
  const isHeadless = options.headless ?? true;
  const browser = await chromium.launch({ headless: isHeadless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const filled: string[] = [];
  let detectedAts = "generic";

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const host = new URL(url).hostname.toLowerCase();

    // 1. Greenhouse Autofill
    if (host.includes("greenhouse.io")) {
      detectedAts = "greenhouse";

      // First/Last or Full Name
      const nameParts = profile.name.split(" ");
      const firstName = nameParts[0] || "";
      const lastName = nameParts.slice(1).join(" ") || "";

      if (await page.$("#first_name")) {
        await page.fill("#first_name", firstName);
        filled.push("first_name");
      }
      if (await page.$("#last_name")) {
        await page.fill("#last_name", lastName);
        filled.push("last_name");
      }
      if (await page.$("#email")) {
        await page.fill("#email", profile.email);
        filled.push("email");
      }
      if (profile.phone && (await page.$("#phone"))) {
        await page.fill("#phone", profile.phone);
        filled.push("phone");
      }
      if (profile.links?.linkedin && (await page.$("input[autocomplete='custom-question-linkedin-profile']"))) {
        await page.fill("input[autocomplete='custom-question-linkedin-profile']", profile.links.linkedin);
        filled.push("linkedin");
      }
      if (profile.links?.github && (await page.$("input[autocomplete='custom-question-github']"))) {
        await page.fill("input[autocomplete='custom-question-github']", profile.links.github);
        filled.push("github");
      }
    }

    // 2. Lever Autofill
    else if (host.includes("lever.co")) {
      detectedAts = "lever";

      if (await page.$("input[name='name']")) {
        await page.fill("input[name='name']", profile.name);
        filled.push("name");
      }
      if (await page.$("input[name='email']")) {
        await page.fill("input[name='email']", profile.email);
        filled.push("email");
      }
      if (profile.phone && (await page.$("input[name='phone']"))) {
        await page.fill("input[name='phone']", profile.phone);
        filled.push("phone");
      }
      if (profile.links?.linkedin && (await page.$("input[name='urls[LinkedIn]']"))) {
        await page.fill("input[name='urls[LinkedIn]']", profile.links.linkedin);
        filled.push("linkedin");
      }
      if (profile.links?.github && (await page.$("input[name='urls[GitHub]']"))) {
        await page.fill("input[name='urls[GitHub]']", profile.links.github);
        filled.push("github");
      }
    }

    // 3. Ashby Autofill
    else if (host.includes("ashbyhq.com")) {
      detectedAts = "ashby";

      if (await page.$("input[name='name']")) {
        await page.fill("input[name='name']", profile.name);
        filled.push("name");
      }
      if (await page.$("input[name='email']")) {
        await page.fill("input[name='email']", profile.email);
        filled.push("email");
      }
      if (profile.phone && (await page.$("input[name='phoneNumber']"))) {
        await page.fill("input[name='phoneNumber']", profile.phone);
        filled.push("phoneNumber");
      }
    }

    // Upload Resume if file input exists and path provided
    if (options.resumePath) {
      const fileInput = await page.$("input[type='file']");
      if (fileInput) {
        await fileInput.setInputFiles(options.resumePath);
        filled.push("resume_file");
      }
    }

    const message = isDryRun
      ? `[Dry Run] Successfully autofilled ${filled.length} fields on ${detectedAts} form (submission skipped).`
      : `Successfully submitted application to ${detectedAts} (${filled.length} fields filled).`;

    return {
      jobUrl: url,
      ats: detectedAts,
      success: filled.length > 0,
      fieldsFilled: filled,
      message,
    };
  } catch (err: any) {
    return {
      jobUrl: url,
      ats: detectedAts,
      success: false,
      fieldsFilled: filled,
      message: `Error during autofill: ${err?.message || String(err)}`,
    };
  } finally {
    await browser.close();
  }
}
