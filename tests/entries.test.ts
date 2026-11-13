import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { CompleteJsonOptions, LlmProvider } from "../src/llm/provider";
import { extractEntries } from "../src/fill/entries";

const resume = readFileSync(resolve(process.cwd(), "tests/fixtures/resume-sample.txt"), "utf8");

const llmReturning = (data: unknown): LlmProvider => ({
  completeJson: async <T,>({ schema }: CompleteJsonOptions<T>) => (schema as z.ZodType<T>).parse(data),
});

describe("extractEntries grounding", () => {
  it("keeps entries that are in the resume and drops or blanks anything invented", async () => {
    const out = await extractEntries(
      llmReturning({
        experience: [
          {
            title: "Programmer Analyst Trainee", company: "Cognizant", location: "Pune",
            startMonth: 7, startYear: 2025, endMonth: null, endYear: null, current: true,
            description: "- Engineered and deployed 15+ .NET API endpoints, delivering 100% alignment with client specifications",
          },
          { title: "Staff Engineer", company: "Google", startYear: 2019, current: false, description: "- Led search" },
          {
            title: "Virtual Research and Development Intern", company: "Samsung R&D",
            startMonth: 6, startYear: 2023, endMonth: 2, endYear: 2024, current: false,
            description: "- Pioneered a quantum compression codec that tripled revenue across seven continents",
          },
        ],
        education: [
          { school: "SRM Institute of Science and Technology", degree: "Bachelor of Technology", field: "Computer Science and Engineering", gpa: "8.47/10", startYear: 2021, endYear: 2025 },
          { school: "Hogwarts", degree: "Wizardry", startYear: 1999, endYear: 2006 },
        ],
      }),
      resume,
    );
    expect(out.experience.map((e) => e.company)).toEqual(["Cognizant", "Samsung R&D"]); // Google dropped
    expect(out.experience[0].location).toBeNull(); // "Pune" is in the resume, but not beside Cognizant
    expect(out.experience[0].current).toBe(true);
    expect(out.experience[0].description).toContain(".NET API endpoints");
    expect(out.experience[1].location).toBeNull(); // not claimed by the model here
    expect(out.experience[1].description).toBe(""); // invented bullet blanked
    expect(out.education.map((e) => e.school)).toEqual(["SRM Institute of Science and Technology"]); // Hogwarts dropped
    expect(out.education[0].gpa).toBe("8.47/10");
  });

  it("does not mark a job current unless the resume says Present", async () => {
    const out = await extractEntries(
      llmReturning({
        experience: [{ title: "Programmer Analyst Trainee", company: "Cognizant", current: true, description: "" }],
        education: [],
      }),
      resume.replace(/Present/g, "2026"),
    );
    expect(out.experience[0].current).toBe(false);
  });
});
