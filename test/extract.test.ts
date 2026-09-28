import { describe, it, expect } from "vitest";
import {
  get,
  first,
  str,
  num,
  bool,
  strArray,
  stripHtml,
  absUrl,
} from "../src/lib/extract.ts";

describe("extract.ts", () => {
  describe("get", () => {
    it("safely traverses dot-separated paths", () => {
      const obj = { a: { b: { c: 42 } } };
      expect(get(obj, "a.b.c")).toBe(42);
      expect(get(obj, "a.b")).toEqual({ c: 42 });
      expect(get(obj, "a.b.c.d")).toBeUndefined();
      expect(get(obj, "x.y.z")).toBeUndefined();
      expect(get(null, "a.b")).toBeUndefined();
      expect(get(undefined, "a.b")).toBeUndefined();
    });
  });

  describe("first", () => {
    it("returns the first non-blank value found across candidate paths", () => {
      const obj = {
        empty: "",
        blankArr: [],
        nullVal: null,
        title: "Software Engineer",
        backupTitle: "Developer",
      };

      expect(first(obj, "empty", "blankArr", "nullVal", "title", "backupTitle")).toBe("Software Engineer");
      expect(first(obj, "nonexistent1", "nonexistent2")).toBeUndefined();
    });
  });

  describe("str", () => {
    it("converts primitives, objects, and arrays to string representations", () => {
      expect(str({ name: "Alice" }, "name")).toBe("Alice");
      expect(str({ count: 10 }, "count")).toBe("10");
      expect(str({ active: true }, "active")).toBe("true");
      expect(str({ tags: ["remote", "fulltime"] }, "tags")).toBe("remote, fulltime");
      expect(str({ loc: { city: "San Diego", state: "CA", country: "USA" } }, "loc")).toBe("San Diego, CA, USA");
      expect(str({ loc: { name: "Headquarters" } }, "loc")).toBe("Headquarters");
      expect(str({ val: "   " }, "val")).toBeNull();
      expect(str({ val: null }, "val")).toBeNull();
    });
  });

  describe("num", () => {
    it("extracts valid numbers from numeric or string values", () => {
      expect(num({ val: 120000 }, "val")).toBe(120000);
      expect(num({ val: "$150,000.50" }, "val")).toBe(150000.5);
      expect(num({ val: "invalid" }, "val")).toBeNull();
      expect(num({ val: null }, "val")).toBeNull();
    });
  });

  describe("bool", () => {
    it("extracts boolean values from boolean or string values", () => {
      expect(bool({ val: true }, "val")).toBe(true);
      expect(bool({ val: false }, "val")).toBe(false);
      expect(bool({ val: "true" }, "val")).toBe(true);
      expect(bool({ val: "yes" }, "val")).toBe(true);
      expect(bool({ val: "1" }, "val")).toBe(true);
      expect(bool({ val: "false" }, "val")).toBe(false);
      expect(bool({ val: "no" }, "val")).toBe(false);
      expect(bool({ val: "0" }, "val")).toBe(false);
      expect(bool({ val: "maybe" }, "val")).toBeNull();
    });
  });

  describe("strArray", () => {
    it("extracts string arrays from arrays of strings, objects, or delimited strings", () => {
      expect(strArray({ skills: ["TypeScript", "Node.js"] }, "skills")).toEqual(["TypeScript", "Node.js"]);
      expect(strArray({ skills: [{ name: "React" }, { label: "Redux" }] }, "skills")).toEqual(["React", "Redux"]);
      expect(strArray({ skills: "React, Node.js; TypeScript | Go" }, "skills")).toEqual(["React", "Node.js", "TypeScript", "Go"]);
      expect(strArray({}, "skills")).toEqual([]);
    });
  });

  describe("stripHtml", () => {
    it("strips HTML tags and normalizes entities and whitespace", () => {
      const html = "<p>Hello <strong>World</strong>!</p><br/><ul><li>Item 1</li><li>Item 2</li></ul>&amp; &lt;test&gt; &quot;quoted&quot;";
      const text = stripHtml(html);

      expect(text).toContain("Hello World!");
      expect(text).toContain("• Item 1");
      expect(text).toContain("• Item 2");
      expect(text).toContain('& <test> "quoted"');
      expect(stripHtml(null)).toBeNull();
      expect(stripHtml("")).toBeNull();
    });
  });

  describe("absUrl", () => {
    it("resolves relative URLs against a base URL", () => {
      expect(absUrl("/jobs/123", "https://example.com")).toBe("https://example.com/jobs/123");
      expect(absUrl("https://other.com/job", "https://example.com")).toBe("https://other.com/job");
      expect(absUrl(null, "https://example.com")).toBeNull();
      expect(absUrl("invalid url", "invalid base")).toBeNull();
    });
  });
});
