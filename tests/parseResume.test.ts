import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseResume, withResumeFacts } from "../src/fill/parseResume";
import { EMPTY_PROFILE } from "../src/shared/storage";

const fx = (n: string) => readFileSync(resolve(process.cwd(), "tests/fixtures", n), "utf8");

describe.each([
  ["clean text", "resume-swe-clean.txt"],
  ["raw PDF text", "resume-swe-raw.txt"],
])("parseResume (SWE resume, %s)", (_n, file) => {
  const out = parseResume(fx(file));

  it("finds the three jobs with titles, companies and dates", () => {
    expect(out.experience.map((e) => [e.title, e.company])).toEqual([
      ["Programmer Analyst Trainee", "Cognizant"],
      [".NET and React Intern", "Cognizant"],
      ["Virtual Research and Development Intern", "Samsung R&D"],
    ]);
    const [a, b, c] = out.experience;
    expect([a.startMonth, a.startYear, a.current, a.endYear]).toEqual([7, 2025, true, null]);
    expect([b.startMonth, b.startYear, b.endMonth, b.endYear, b.current]).toEqual([1, 2025, 6, 2025, false]);
    expect([c.startMonth, c.startYear, c.endMonth, c.endYear]).toEqual([6, 2023, 2, 2024]);
  });

  it("reads locations only when they are real places, not work modes", () => {
    expect(out.experience.map((e) => e.location)).toEqual([null, null, "Online, Chennai"]);
  });

  it("keeps bullets verbatim, joining wrapped lines", () => {
    const d = out.experience[0].description;
    expect(d).toContain("- Engineered and deployed 15+ .NET API endpoints, delivering 100% alignment with client specifications and reducing change requests by 20%.");
    expect(d.split("\n")).toHaveLength(3);
    expect(out.experience[2].description.split("\n")).toHaveLength(3);
  });

  it("finds both education entries with degree, field and grade", () => {
    expect(out.education).toHaveLength(2);
    const [uni, school] = out.education;
    expect(uni).toMatchObject({
      school: "SRM Institute of Science and Technology",
      degree: "Bachelor of Technology",
      field: "Computer Science and Engineering",
      gpa: "8.47/10", startYear: 2021, endYear: 2025,
    });
    expect(school).toMatchObject({ school: "B.K. Birla Centre for Education", gpa: "93.80", startYear: 2019, endYear: 2021 });
  });

  it("does not mistake coursework or project lines for entries", () => {
    expect(out.education.map((e) => e.school)).not.toContain("Relevant Coursework");
    expect(out.experience).toHaveLength(3);
  });
});

describe("parseResume (Data Analyst resume)", () => {
  it.each(["resume-da-clean.txt", "resume-da-raw.txt"])("reads %s", (file) => {
    const out = parseResume(fx(file));
    expect(out.experience.map((e) => e.company)).toEqual(["Cognizant", "Cognizant", "Samsung R&D"]);
    expect(out.education[0].gpa).toMatch(/^8\.4\d?\/10$|^8\.5\/10$/);
    expect(out.experience[2].description.split("\n").length).toBeGreaterThanOrEqual(2);
  });
});

describe("parseResume edge cases", () => {
  it("returns nothing, rather than guessing, for text with no recognisable sections", () => {
    expect(parseResume("Just some paragraph about me and my hobbies.")).toEqual({ experience: [], education: [] });
  });

  it("skips an entry that has no company line", () => {
    const out = parseResume("EXPERIENCE\nEngineer | Jan 2020 – Mar 2021\n- did things\n");
    expect(out.experience).toEqual([]);
  });

  it("handles 'to' ranges and full month names", () => {
    const out = parseResume("Experience\nAnalyst | January 2019 to December 2020\nAcme Corp | Pune\n- one\n");
    expect(out.experience[0]).toMatchObject({ company: "Acme Corp", location: "Pune", startMonth: 1, endMonth: 12, endYear: 2020 });
  });
});

describe("withResumeFacts", () => {
  const out = parseResume(fx("resume-swe-clean.txt"));
  it("fills blank college answers from the degree entry, not the school-level one", () => {
    const p = withResumeFacts(EMPTY_PROFILE, out);
    expect(p).toMatchObject({
      school: "SRM Institute of Science and Technology", degree: "Bachelor of Technology",
      fieldOfStudy: "Computer Science and Engineering", cgpa: "8.47", graduationYear: "2025",
      currentCompany: "Cognizant", currentTitle: "Programmer Analyst Trainee",
    });
  });
  it("never overwrites what you typed", () => {
    const p = withResumeFacts({ ...EMPTY_PROFILE, cgpa: "9.0", school: "My Uni" }, out);
    expect([p.cgpa, p.school]).toEqual(["9.0", "My Uni"]);
  });
});
