import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { CompleteJsonOptions, LlmProvider } from "../src/llm/provider";
import { buildReport, planFill } from "../src/fill/plan";
import { draftAnswers } from "../src/fill/draftAnswers";
import { fillPage, scanPage } from "../src/fill/inject";
import { EMPTY_PROFILE, type Profile } from "../src/shared/storage";
import type { PageContext } from "../src/shared/types";

const FORM = `
<h1>Backend Engineer</h1>
<p>We build .NET services.</p>
<form id="apply">
  <label for="n">Full name *</label><input id="n" type="text" />
  <label for="e">Email address</label><input id="e" type="email" />
  <label for="c">Current city</label><input id="c" type="text" value="Mumbai" />
  <label for="x">Expected CTC (LPA)</label><input id="x" type="text" />
  <label for="d">How many years of experience do you have with Kubernetes?</label><input id="d" type="number" />
  <label for="ne">Years of experience in .NET</label>
  <select id="ne"><option value="">Select</option><option>0-1 years</option><option>1-3 years</option><option>3+ years</option></select>
  <label for="w">Why do you want this role?</label><textarea id="w" maxlength="300"></textarea>
  <fieldset><legend>Are you legally authorised to work in India?</legend>
    <label><input type="radio" name="auth" value="y" /> Yes</label>
    <label><input type="radio" name="auth" value="n" /> No</label>
  </fieldset>
  <label for="g">Gender</label>
  <select id="g"><option value="">Select</option><option>Female</option><option>Male</option></select>
  <label><input type="checkbox" id="t" /> I agree to the terms and conditions</label>
  <label for="f">Resume</label><input id="f" type="file" />
  <input type="hidden" name="csrf" value="x" />
  <input type="password" id="pw" />
  <div style="display:none"><label for="h">Hidden question</label><input id="h" type="text" /></div>
  <button id="submit" type="submit">Submit application</button>
</form>`;

const profile: Profile = {
  ...EMPTY_PROFILE,
  fullName: "Aditya Achuthan",
  email: "a@example.com",
  skillYears: ".NET: 1.5",
};
const resume = "x".repeat(300);
const ctx = (): PageContext => ({ title: "Job", heading: "Backend Engineer", pageText: "We build .NET services." });

/** Stand-in for Gemini. Answers what a careful model would, plus one deliberately bad option. */
function fakeLlm(): LlmProvider {
  return {
    async completeJson<T>({ prompt, schema }: CompleteJsonOptions<T>): Promise<T> {
      const qs = JSON.parse(prompt.split("QUESTIONS:\n")[1]) as { id: string; question: string }[];
      const answers = qs.map((q) => ({
        id: q.id,
        answer: /why/i.test(q.question) ? "I enjoy building .NET APIs, as I do at work today."
          : /authori/i.test(q.question) ? "Definitely"
          : null,
      }));
      return (schema as z.ZodType<T>).parse({ answers });
    },
  };
}

let submits = 0;
let buttonClicks = 0;

beforeEach(() => {
  document.body.innerHTML = FORM;
  submits = 0;
  buttonClicks = 0;
  document.getElementById("apply")!.addEventListener("submit", (e) => { submits++; e.preventDefault(); });
  document.getElementById("submit")!.addEventListener("click", () => { buttonClicks++; });
});

describe("scanPage", () => {
  it("finds visible controls with correct labels and skips hidden, password and csrf fields", () => {
    const { fields } = scanPage();
    const labels = fields.map((f) => f.label);
    expect(labels).toContain("Full name");
    expect(labels).toContain("Email address");
    expect(labels).toContain("Are you legally authorised to work in India?");
    expect(labels).not.toContain("Hidden question");
    expect(fields.some((f) => f.kind === "text" && f.label === "")).toBe(false);
    expect(fields).toHaveLength(11); // hidden, password, csrf and display:none controls excluded
  });

  it("reads radio options and select options, and notices prefilled values", () => {
    const { fields } = scanPage();
    const radio = fields.find((f) => f.kind === "radio")!;
    expect(radio.options).toEqual(["Yes", "No"]);
    const sel = fields.find((f) => f.label.startsWith("Years of experience in .NET"))!;
    expect(sel.options).toEqual(["0-1 years", "1-3 years", "3+ years"]);
    expect(fields.find((f) => f.label === "Current city")!.filled).toBe(true);
  });
});

describe("plan + fill", () => {
  async function runAll() {
    const { fields } = scanPage();
    const { instructions, aiError } = await planFill({ fields, context: ctx(), resumeText: resume, profile, llm: fakeLlm() });
    const outcomes = await fillPage(instructions);
    return { fields, instructions, outcomes, aiError, report: buildReport(fields, instructions, outcomes, aiError) };
  }

  it("fills profile fields, drafts open answers, and leaves the rest for the person", async () => {
    const { report } = await runAll();
    expect((document.getElementById("n") as HTMLInputElement).value).toBe("Aditya Achuthan");
    expect((document.getElementById("e") as HTMLInputElement).value).toBe("a@example.com");
    expect((document.getElementById("ne") as HTMLSelectElement).value).toBe("1-3 years");
    expect((document.getElementById("w") as HTMLTextAreaElement).value).toContain(".NET");
    expect(report.aiDrafts.map((d) => d.label)).toContain("Why do you want this role?");
    // never guessed: no CTC in profile, Kubernetes not in skill list, bad AI option rejected
    expect((document.getElementById("x") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("d") as HTMLInputElement).value).toBe("");
    expect(document.querySelectorAll<HTMLInputElement>('input[name="auth"]:checked')).toHaveLength(0);
    expect(report.needsYou).toEqual(expect.arrayContaining(["Expected CTC (LPA)", "Are you legally authorised to work in India?"]));
  });

  it("never touches protected, consent, file or already-filled fields", async () => {
    await runAll();
    expect((document.getElementById("g") as HTMLSelectElement).value).toBe("");
    expect((document.getElementById("t") as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById("f") as HTMLInputElement).value).toBe("");
    expect((document.getElementById("c") as HTMLInputElement).value).toBe("Mumbai");
  });

  it("colour-codes fields", async () => {
    await runAll();
    expect((document.getElementById("n") as HTMLElement).style.outline).toContain("#2e9e5b");
    expect((document.getElementById("w") as HTMLElement).style.outline).toContain("#2f6fdb");
    expect((document.getElementById("g") as HTMLElement).style.outline).toContain("#e08a00");
  });

  it("NEVER submits the form or clicks the submit button", async () => {
    await runAll();
    expect(submits).toBe(0);
    expect(buttonClicks).toBe(0);
  });

  it("still applies profile fills when the AI call fails", async () => {
    const { fields } = scanPage();
    const broken: LlmProvider = { completeJson: async () => { throw new Error("All models failed"); } };
    const { instructions, aiError } = await planFill({ fields, context: ctx(), resumeText: resume, profile, llm: broken });
    await fillPage(instructions);
    expect(aiError).toContain("All models failed");
    expect((document.getElementById("n") as HTMLInputElement).value).toBe("Aditya Achuthan");
    expect((document.getElementById("w") as HTMLTextAreaElement).value).toBe("");
  });

  it("selects a radio option when the model returns a real one", async () => {
    const { fields } = scanPage();
    const radio = fields.find((f) => f.kind === "radio")!;
    const llm: LlmProvider = {
      completeJson: async <T,>({ schema }: CompleteJsonOptions<T>) =>
        (schema as z.ZodType<T>).parse({ answers: [{ id: radio.id, answer: "Yes" }] }),
    };
    const answers = await draftAnswers(llm, { fields: [radio], context: ctx(), resumeText: resume, profile });
    expect(answers.get(radio.id)).toBe("Yes");
    await fillPage([{ id: radio.id, status: "ai", value: "Yes" }]);
    expect(document.querySelectorAll<HTMLInputElement>('input[name="auth"]:checked')[0].value).toBe("y");
    expect(submits).toBe(0);
  });
});

describe("source guard", () => {
  it("inject.ts never calls submit or fires submit/keyboard-enter events", () => {
    const src = readFileSync(resolve(process.cwd(), "src/fill/inject.ts"), "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/\.submit\(|requestSubmit|new SubmitEvent|key: "Enter"/);
  });
});

describe("serialization", () => {
  it("scanPage and fillPage work after being turned into source text, as Chrome injects them", async () => {
    const scan = new Function(`return (${scanPage.toString()})`)() as typeof scanPage;
    const fill = new Function(`return (${fillPage.toString()})`)() as typeof fillPage;
    const { fields } = scan();
    expect(fields).toHaveLength(11);
    const name = fields.find((f) => f.label === "Full name")!;
    const out = await fill([{ id: name.id, status: "profile", value: "Test User" }]);
    expect(out[0].applied).toBe(true);
    expect((document.getElementById("n") as HTMLInputElement).value).toBe("Test User");
  });
});
