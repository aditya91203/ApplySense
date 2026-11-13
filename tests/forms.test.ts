import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseResume, withResumeFacts } from "../src/fill/parseResume";
import { buildReport, planFill } from "../src/fill/plan";
import { advancePage, fillPage, scanPage } from "../src/fill/inject";
import { EMPTY_PROFILE, type Profile } from "../src/shared/storage";

const resume = readFileSync(resolve(process.cwd(), "tests/fixtures/resume-swe-clean.txt"), "utf8");
const seed = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/profile.json"), "utf8")) as Partial<Profile>;
const profile = withResumeFacts({ ...EMPTY_PROFILE, ...seed }, parseResume(resume));
const ctx = { title: "Form", heading: "Form", pageText: "" };

let clicks: string[] = [];
const watch = () => {
  document.querySelectorAll('button,[role="button"]').forEach((b) => {
    b.addEventListener("click", () => clicks.push((b.textContent ?? "").trim()));
  });
};

async function fillAll() {
  const { fields } = scanPage();
  const { instructions } = await planFill({ fields, context: ctx, resumeText: resume, profile }); // no AI
  const outcomes = await fillPage(instructions);
  return { fields, instructions, outcomes, report: buildReport(fields, instructions, outcomes) };
}

beforeEach(() => { document.body.innerHTML = ""; clicks = []; });

// ---------------------------------------------------------------------------
describe("Google Forms", () => {
  const item = (title: string, required: boolean, body: string) =>
    `<div role="listitem"><div role="heading" aria-level="3"><span>${title}</span>${
      required ? '<span aria-label="Required question"> *</span>' : ""
    }</div>${body}</div>`;
  const radio = (v: string) => `<div role="radio" aria-checked="false" aria-label="${v}" data-value="${v}"></div>`;
  const check = (v: string) => `<div role="checkbox" aria-checked="false" aria-label="${v}" data-answer-value="${v}"></div>`;

  beforeEach(() => {
    document.body.innerHTML = `
    <form action="https://docs.google.com/forms/d/e/ABC/formResponse"><div role="list">
      ${item("Full name", true, '<input type="text" aria-labelledby="x" />')}
      ${item("Email", true, '<input type="email" />')}
      ${item("College name", true, '<input type="text" />')}
      ${item("Phone number", false, '<input type="text" />')}
      ${item("How did you hear about us?", true,
        `<div role="radiogroup">${radio("LinkedIn")}${radio("A friend")}${radio("Other:")}<input type="text" aria-label="Other response" /></div>`)}
      ${item("Country", true,
        `<div role="listbox" aria-expanded="false"><div role="presentation" class="popup" style="display:none">
           <div role="option" data-value="" aria-selected="true">Choose</div>
           <div role="option" data-value="India" aria-selected="false">India</div>
           <div role="option" data-value="Indonesia" aria-selected="false">Indonesia</div>
           <div role="option" data-value="United States" aria-selected="false">United States</div></div></div>`)}
      ${item("Languages you know", false, `<div role="group">${check("English")}${check("Hindi")}</div>`)}
      ${item("Why do you want to join our club?", true, "<textarea></textarea>")}
    </div>
    <div role="button"><span>Back</span></div>
    <div role="button"><span>Next</span></div>
    <div role="button"><span>Submit</span></div></form>`;

    // minimal behaviour of the real widgets
    document.querySelectorAll<HTMLElement>('[role="radio"]').forEach((r) =>
      r.addEventListener("click", () => {
        r.parentElement!.querySelectorAll('[role="radio"]').forEach((o) => o.setAttribute("aria-checked", "false"));
        r.setAttribute("aria-checked", "true");
      }));
    const lb = document.querySelector<HTMLElement>('[role="listbox"]')!;
    const popup = lb.querySelector<HTMLElement>(".popup")!;
    lb.addEventListener("click", (e) => {
      if ((e.target as Element).closest('[role="option"]')) return;
      const open = lb.getAttribute("aria-expanded") === "true";
      lb.setAttribute("aria-expanded", String(!open));
      popup.style.display = open ? "none" : "block";
    });
    lb.querySelectorAll<HTMLElement>('[role="option"]').forEach((o) =>
      o.addEventListener("click", () => {
        lb.querySelectorAll('[role="option"]').forEach((x) => x.setAttribute("aria-selected", "false"));
        o.setAttribute("aria-selected", "true");
        lb.setAttribute("aria-expanded", "false");
        popup.style.display = "none";
      }));
    watch();
  });

  it("reads question titles, required marks and control types", () => {
    const { fields } = scanPage();
    const by = (l: string) => fields.find((f) => f.label === l)!;
    expect(by("Full name")).toMatchObject({ kind: "text", required: true });
    expect(by("Phone number").required).toBe(false);
    expect(by("How did you hear about us?")).toMatchObject({ kind: "radio", options: ["LinkedIn", "A friend", "Other:"], required: true });
    expect(by("Country")).toMatchObject({ kind: "dropdown", required: true, filled: false });
    expect(by("Languages you know")).toMatchObject({ kind: "checkbox", options: ["English", "Hindi"] });
  });

  it("does not treat the 'Other:' text box as a separate question", () => {
    expect(scanPage().fields.filter((f) => /other/i.test(f.label))).toHaveLength(0);
  });

  it("fills the questions your details cover, picks the dropdown option, and skips the rest", async () => {
    const { report } = await fillAll();
    const text = (i: number) => document.querySelectorAll<HTMLInputElement>('input[type="text"],input[type="email"]')[i].value;
    expect(text(0)).toBe("Alex Example");
    expect(text(1)).toBe("alex@example.com");
    expect(text(2)).toBe("SRM Institute of Science and Technology"); // from the resume
    expect(text(3)).toBe("9000000000");
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("data-value")).toBe("Other:");
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value")).toBe("India");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Other response"]')!.value).toBe("");
    expect(document.querySelectorAll('[role="checkbox"][aria-checked="true"]')).toHaveLength(0);
    expect(document.querySelector("textarea")!.value).toBe("");
    expect(report.needsYou).toEqual(expect.arrayContaining(["Why do you want to join our club?", "Languages you know"]));
    expect(report.blocking).toEqual(["Why do you want to join our club?"]); // required and open-ended: stops auto-advance
    expect(clicks).toEqual([]); // no Next, no Submit
  });

  it("clicks Next but never Submit", () => {
    expect(advancePage()).toEqual({ clicked: true, label: "next" });
    expect(clicks).toEqual(["Next"]);
  });

  it("refuses on the last page where only Submit remains", () => {
    document.querySelectorAll('[role="button"]').forEach((b) => { if (/next|back/i.test(b.textContent ?? "")) b.remove(); });
    const r = advancePage();
    expect(r.clicked).toBe(false);
    expect(r.reason).toMatch(/submit it yourself/i);
    expect(clicks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("Microsoft Forms", () => {
  const q = (n: number, title: string, body: string) => `
    <div id="QuestionId_r${n}" data-automation-id="questionItem">
      <div role="heading" aria-level="2"><span data-automation-id="questionTitle">
        <span data-automation-id="questionOrdinal">${n}.</span><span class="text-format-content">${title}</span>
        <span id="QuestionInfo_r${n}" aria-hidden="true">Single line text.</span></span>
        <span data-automation-id="requiredStar">*</span></div>${body}</div>`;

  beforeEach(() => {
    document.body.innerHTML = `<div>
      ${q(1, "Full name", '<input data-automation-id="textInput" aria-label="Single line text " aria-labelledby="QuestionId_r1 QuestionInfo_r1" placeholder="Enter your answer" />')}
      ${q(2, "Email address", '<input data-automation-id="textInput" aria-labelledby="QuestionId_r2 QuestionInfo_r2" />')}
      ${q(3, "Are you legally eligible to work in India?",
        `<div role="radiogroup" aria-labelledby="QuestionId_r3"><label><input type="radio" name="q3"/><span>Yes</span></label><label><input type="radio" name="q3"/><span>No</span></label></div>`)}
      ${q(4, "Tell us about yourself", '<textarea data-automation-id="textInput"></textarea>')}
      <button data-automation-id="nextButton">Next</button>
      <button data-automation-id="submitButton">Submit</button></div>`;
    watch();
  });

  it("uses the question title, not the container text, as the label", () => {
    const labels = scanPage().fields.map((f) => f.label);
    expect(labels).toEqual(["Full name", "Email address", "Tell us about yourself", "Are you legally eligible to work in India?"]);
    expect(scanPage().fields.every((f) => f.required)).toBe(true);
  });

  it("fills text and radio questions and leaves the open one for you", async () => {
    const { report } = await fillAll();
    const inputs = document.querySelectorAll<HTMLInputElement>('input[data-automation-id="textInput"]');
    expect([inputs[0].value, inputs[1].value]).toEqual(["Alex Example", "alex@example.com"]);
    expect(document.querySelector<HTMLInputElement>('input[name="q3"]:checked')?.parentElement?.textContent).toBe("Yes");
    expect(document.querySelector("textarea")!.value).toBe("");
    expect(report.needsYou).toEqual(["Tell us about yourself"]);
    expect(clicks).toEqual([]);
  });

  it("clicks Next, never the submitButton", () => {
    expect(advancePage().label).toBe("next");
    expect(clicks).toEqual(["Next"]);
  });

  it("refuses a final-step button even if it is labelled Next", () => {
    document.querySelector('[data-automation-id="nextButton"]')!.remove();
    document.querySelector('[data-automation-id="submitButton"]')!.textContent = "Next";
    const r = advancePage();
    expect(r.clicked).toBe(false);
    expect(clicks).toEqual([]);
  });
});
