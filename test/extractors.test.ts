import { describe, it, expect } from "vitest";
import {
  decodeEntities,
  tryJson,
  sliceJson,
  jsonLdBlocks,
  embeddedJson,
  looksLikeJob,
  findJobObjects,
  extractLocation,
  extractSalary,
  extractEmploymentType,
  extractWorkMode,
  genericJob,
  extractFromHtml,
  extractGeneric,
} from "../src/extractors.ts";

describe("extractors.ts", () => {
  describe("decodeEntities", () => {
    it("decodes common and numeric HTML entities", () => {
      expect(decodeEntities("&quot;hello&quot; &amp; &#39;world&#39;")).toBe('"hello" & \'world\'');
      expect(decodeEntities("C&#x2B;&#x2B; Developer")).toBe("C++ Developer");
      expect(decodeEntities("&#65;&#66;&#67;")).toBe("ABC");
      expect(decodeEntities("&lt;div&gt;&nbsp;&lt;/div&gt;")).toBe("<div> </div>");
    });
  });

  describe("tryJson", () => {
    it("parses valid JSON", () => {
      expect(tryJson('{"foo": "bar"}')).toEqual({ foo: "bar" });
    });

    it("parses encoded JSON", () => {
      expect(tryJson('{&quot;name&quot;: &quot;John&quot;}')).toEqual({ name: "John" });
    });

    it("handles trailing commas", () => {
      expect(tryJson('{"a": 1, "b": [1, 2, ], }')).toEqual({ a: 1, b: [1, 2] });
    });

    it("returns undefined on invalid input", () => {
      expect(tryJson("not a json")).toBeUndefined();
      expect(tryJson("")).toBeUndefined();
    });
  });

  describe("sliceJson", () => {
    it("slices balanced JSON object and array", () => {
      const text = 'prefix window.data = {"a": {"b": [1, 2, "3{4}"]}}; suffix';
      const startIdx = text.indexOf("{");
      const sliced = sliceJson(text, startIdx);
      expect(sliced).toBe('{"a": {"b": [1, 2, "3{4}"]}}');
      expect(JSON.parse(sliced!)).toEqual({ a: { b: [1, 2, "3{4}"] } });
    });

    it("handles comments and strings with brackets", () => {
      const text = 'const data = { /* comment } */ "str": "bracket } in string", // line comment }\n "num": 42 };';
      const startIdx = text.indexOf("{");
      const sliced = sliceJson(text, startIdx);
      expect(sliced).not.toBeNull();
      expect(sliced).toContain('"num": 42');
    });

    it("returns null on unclosed brackets", () => {
      expect(sliceJson('{"a": 1', 0)).toBeNull();
    });
  });

  describe("jsonLdBlocks", () => {
    it("extracts schema.org JobPosting JSON-LD blocks including @graph", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <script type="application/ld+json">
              {
                "@context": "https://schema.org",
                "@type": "JobPosting",
                "title": "Lead Software Engineer",
                "description": "Lead our backend team."
              }
            </script>
            <script type="application/ld&#x2B;json">
              {
                "@context": "https://schema.org",
                "@graph": [
                  {
                    "@type": "Organization",
                    "name": "Acme Inc"
                  },
                  {
                    "@type": "JobPosting",
                    "title": "Frontend Architect",
                    "description": "Architect our web apps."
                  }
                ]
              }
            </script>
          </head>
        </html>
      `;

      const blocks = jsonLdBlocks(html);
      expect(blocks.length).toBeGreaterThanOrEqual(2);
      const jobs = blocks.filter((b: any) => b["@type"] === "JobPosting");
      expect(jobs).toHaveLength(2);
      expect((jobs[0] as any).title).toBe("Lead Software Engineer");
      expect((jobs[1] as any).title).toBe("Frontend Architect");
    });
  });

  describe("embeddedJson & findJobObjects", () => {
    it("extracts objects from script tags and window variables", () => {
      const html = `
        <html>
          <script id="__NEXT_DATA__" type="application/json">
            {
              "props": {
                "pageProps": {
                  "job": {
                    "title": "Cloud Solutions Architect",
                    "companyName": "CloudCorp",
                    "location": "Remote, US",
                    "salary": "$180,000 - $220,000"
                  }
                }
              }
            }
          </script>
          <script>
            window.__INITIAL_STATE__ = {
              "jobDetails": {
                "jobTitle": "DevOps Engineer",
                "hiringOrganization": { "name": "OpsTech" },
                "jobLocation": { "name": "Austin, TX" },
                "datePosted": "2026-05-01"
              }
            };
          </script>
        </html>
      `;

      const blobs = embeddedJson(html);
      expect(blobs.length).toBeGreaterThanOrEqual(2);

      const jobs = blobs.flatMap((b) => findJobObjects(b));
      expect(jobs.length).toBeGreaterThanOrEqual(2);
      const titles = jobs.map((j) => j.title || j.jobTitle);
      expect(titles).toContain("Cloud Solutions Architect");
      expect(titles).toContain("DevOps Engineer");
    });
  });

  describe("looksLikeJob", () => {
    it("identifies JobPosting types and signal-rich job objects", () => {
      expect(looksLikeJob({ "@type": "JobPosting", title: "Engineer" })).toBe(true);
      expect(looksLikeJob({
        title: "Senior Backend Developer",
        company: "Stripe",
        location: "San Francisco, CA",
        salary: "$160,000",
      })).toBe(true);
    });

    it("rejects non-job objects and rejected titles", () => {
      expect(looksLikeJob({ title: "Sign In", company: "Google" })).toBe(false);
      expect(looksLikeJob({ title: "Privacy Policy", company: "Meta", location: "Global" })).toBe(false);
      expect(looksLikeJob({ name: "Navigation Menu", items: [] })).toBe(false);
    });
  });

  describe("extractLocation", () => {
    it("extracts schema PostalAddress, Place name, and flat strings", () => {
      expect(extractLocation({
        jobLocation: {
          address: {
            addressLocality: "San Diego",
            addressRegion: "CA",
            addressCountry: "USA",
          },
        },
      })).toBe("San Diego, CA, USA");

      expect(extractLocation({
        jobLocation: { name: "London HQ" },
      })).toBe("London HQ");

      expect(extractLocation({
        formattedLocation: "Seattle, WA (Hybrid)",
      })).toBe("Seattle, WA (Hybrid)");
    });
  });

  describe("extractSalary", () => {
    it("extracts structured MonetaryAmount and string compensation", () => {
      const s1 = extractSalary({
        baseSalary: {
          minValue: 120000,
          maxValue: 160000,
          currency: "USD",
          unitText: "YEAR",
        },
      });
      expect(s1?.min).toBe(120000);
      expect(s1?.max).toBe(160000);
      expect(s1?.annualMax).toBe(160000);

      const s2 = extractSalary({
        salaryRange: {
          min: 65,
          max: 85,
          currency: "USD",
          interval: "hour",
        },
      });
      expect(s2?.min).toBe(65);
      expect(s2?.max).toBe(85);
      expect(s2?.period).toBe("hour");
      expect(s2?.annualMin).toBe(65 * 2080);
    });
  });

  describe("genericJob", () => {
    it("maps full schema.org JobPosting object to RawJob", () => {
      const raw = {
        "@type": "JobPosting",
        title: "Senior Full Stack Engineer",
        hiringOrganization: {
          name: "Acme Software",
          logo: "https://example.com/logo.png",
        },
        jobLocation: {
          address: {
            addressLocality: "New York",
            addressRegion: "NY",
          },
        },
        jobLocationType: "TELECOMMUTE",
        employmentType: ["FULL_TIME"],
        baseSalary: {
          minValue: 150000,
          maxValue: 190000,
          currency: "USD",
          unitText: "YEAR",
        },
        datePosted: "2026-06-01T00:00:00Z",
        url: "/jobs/senior-full-stack",
        description: "<p>We are seeking a <strong>Senior Engineer</strong> to join our platform team.</p>",
        skills: ["React", "Node.js", "GraphQL"],
      };

      const job = genericJob(raw, "https://acme.com");
      expect(job).not.toBeNull();
      expect(job!.title).toBe("Senior Full Stack Engineer");
      expect(job!.company).toBe("Acme Software");
      expect(job!.location).toBe("New York, NY");
      expect(job!.workMode).toBe("remote");
      expect(job!.employmentType).toBe("full_time");
      expect(job!.salary?.annualMin).toBe(150000);
      expect(job!.salary?.annualMax).toBe(190000);
      expect(job!.url).toBe("https://acme.com/jobs/senior-full-stack");
      expect(job!.description).toBe("We are seeking a Senior Engineer to join our platform team.");
      expect(job!.skills).toEqual(["React", "Node.js", "GraphQL"]);
      expect(job!.companyLogo).toBe("https://example.com/logo.png");
    });
  });

  describe("extractFromHtml & extractGeneric", () => {
    it("extracts jobs from microdata in HTML", () => {
      const html = `
        <div itemscope itemtype="http://schema.org/JobPosting">
          <h1 itemprop="title">Principal Site Reliability Engineer</h1>
          <span itemprop="hiringOrganization">SRE Corp</span>
          <span itemprop="jobLocation">Remote, US</span>
          <span itemprop="baseSalary">$200k - $240k</span>
          <div itemprop="description"><p>Lead reliability architecture.</p></div>
          <a itemprop="url" href="/careers/principal-sre">Apply</a>
        </div>
      `;

      const jobs = extractFromHtml(html, "https://srecorp.com");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.title).toBe("Principal Site Reliability Engineer");
      expect(jobs[0]!.company).toBe("SRE Corp");
      expect(jobs[0]!.workMode).toBe("remote");
      expect(jobs[0]!.salary?.annualMin).toBe(200000);
      expect(jobs[0]!.url).toBe("https://srecorp.com/careers/principal-sre");
    });

    it("extracts jobs from Workday and ATS DOM structure", () => {
      const html = `
        <div class="job-detail">
          <h1 data-automation-id="jobPostingHeader">Staff Machine Learning Engineer</h1>
          <div data-automation-id="companyName">NVIDIA</div>
          <div data-automation-id="locations">Santa Clara, CA (Hybrid)</div>
          <div data-automation-id="salary">$220,000 - $280,000 USD</div>
          <div data-automation-id="jobPostingDescription"><p>Design LLM inference pipelines.</p></div>
          <a data-automation-id="adventureButton" href="https://nvidia.wd5.myworkdayjobs.com/apply/123">Apply Now</a>
        </div>
      `;

      const jobs = extractGeneric(html, "https://nvidia.wd5.myworkdayjobs.com");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.title).toBe("Staff Machine Learning Engineer");
      expect(jobs[0]!.company).toBe("NVIDIA");
      expect(jobs[0]!.workMode).toBe("hybrid");
      expect(jobs[0]!.salary?.annualMin).toBe(220000);
      expect(jobs[0]!.salary?.annualMax).toBe(280000);
      expect(jobs[0]!.applyUrl).toBe("https://nvidia.wd5.myworkdayjobs.com/apply/123");
    });
  });
});
