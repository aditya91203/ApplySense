import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { CompleteJsonOptions, LlmProvider } from "../src/llm/provider";
import { buildReport, planFill } from "../src/fill/plan";
import { planEntry, type EduEntry, type WorkEntry } from "../src/fill/entries";
import { advancePage, fillPage, pageSignature, prepareSection, scanPage } from "../src/fill/inject";
import { EMPTY_PROFILE, type Profile } from "../src/shared/storage";

const seed = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/profile.json"), "utf8")) as Partial<Profile>;
const profile: Profile = { ...EMPTY_PROFILE, ...seed };
const noLlm: LlmProvider = {
  completeJson: async <T,>({ schema }: CompleteJsonOptions<T>) => (schema as z.ZodType<T>).parse({ answers: [] }),
};
const ctx = { title: "Apply", heading: "My Information", pageText: "" };

let events: string[] = [];
const trap = (sel: string) => {
  document.querySelectorAll(sel).forEach((b) => {
    b.addEventListener("click", () => events.push(`click:${b.textContent}`));
  });
  document.querySelectorAll("form").forEach((f) => f.addEventListener("submit", (e) => { events.push("submit"); e.preventDefault(); }));
};

beforeEach(() => { events = []; document.body.innerHTML = ""; });

// ---------------------------------------------------------------------------
describe("the exact questions from the PwC-style form (native controls)", () => {
  const yn = (name: string, legend: string) =>
    `<fieldset><legend>${legend}</legend><label><input type="radio" name="${name}"/> Yes</label><label><input type="radio" name="${name}"/> No</label></fieldset>`;
  const sel = (id: string, label: string, opts: string[]) =>
    `<label for="${id}">${label}</label><select id="${id}"><option value="">Select</option>${opts.map((o) => `<option>${o}</option>`).join("")}</select>`;
  const txt = (id: string, label: string) => `<label for="${id}">${label}</label><input id="${id}" type="text"/>`;

  beforeEach(() => {
    document.body.innerHTML = `<form>
      ${sel("hear", "How did you hear about Us?*", ["LinkedIn", "Referral", "Other"])}
      ${sel("src", "Source", ["Job board", "Other"])}
      ${txt("fn", "First Name*")}${txt("ln", "Last Name*")}
      ${txt("a1", "Address Line 1")}${txt("a2", "Address Line 2")}${txt("city", "City")}${txt("pc", "Postal Code")}
      ${sel("country", "Country", ["India", "United States"])}
      ${txt("em", "Email Address*")}
      ${sel("dev", "Phone Device Type", ["Home", "Mobile"])}
      ${sel("cc", "Country Phone Code*", ["India (+91)", "United Kingdom (+44)"])}
      ${txt("ph", "Phone number*")}
      ${txt("np", "What is your notice period / availability to join if selected (answer in days) ?*")}
      ${yn("elig", "Are you legally eligible to work in the country/region in which this job is located?*")}
      ${yn("rel", "Are you willing to relocate for this role?*")}
      ${txt("sal", "What are your annual base salary expectations please include currency ?")}
      ${yn("age", "Do you meet the minimum working age for the country you are applying the job for?*")}
      ${yn("prev", "Have you previously worked or are currently employed in any capacity with PwC?*")}
      ${yn("pa", "Do you currently work with our Principal Accountant PWC?*")}
      <button id="s" type="submit">Submit application</button><button id="a" type="button">Apply</button>
    </form>`;
    trap("button");
  });

  it("fills every one of them with your answers and submits nothing", async () => {
    const { fields } = scanPage();
    const { instructions } = await planFill({ fields, context: ctx, resumeText: "x".repeat(300), profile, llm: noLlm });
    const out = await fillPage(instructions);
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

    expect(v("hear")).toBe("Other");
    expect(v("src")).toBe("Other");
    expect([v("fn"), v("ln")]).toEqual(["Alex", "Example"]);
    expect([v("a1"), v("a2"), v("city"), v("pc")]).toEqual(["12 Example Street", "Sample Nagar", "Mumbai", "400001"]);
    expect(v("country")).toBe("India");
    expect(v("em")).toBe("alex@example.com");
    expect(v("dev")).toBe("Mobile");
    expect(v("cc")).toBe("India (+91)");
    expect(v("ph")).toBe("9000000000");
    expect(v("np")).toBe("45");
    expect(v("sal")).toBe("1000000 INR");

    const checked = (name: string) =>
      document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.parentElement?.textContent?.trim();
    expect(checked("elig")).toBe("Yes");
    expect(checked("rel")).toBe("Yes");
    expect(checked("age")).toBe("Yes");
    expect(checked("prev")).toBe("No");
    expect(checked("pa")).toBe("No");

    expect(out.every((o) => o.applied)).toBe(true);
    expect(buildReport(fields, instructions, out).blocking).toEqual([]);
    expect(events).toEqual([]); // no Submit, no Apply, nothing
  });
});

// ---------------------------------------------------------------------------
describe("custom dropdowns", () => {
  beforeEach(() => {
    document.body.innerHTML = `<form>
      <button id="country" type="button" aria-haspopup="listbox" aria-label="Country Select Required">Select One</button>
      <div data-automation-id="multiSelectContainer"><input id="how" role="combobox" aria-label="How Did You Hear About Us? Required" /></div>
      <button id="s" type="submit">Submit</button></form>`;
    const body = document.body;
    // button + listbox popup (portal into body), like many design systems
    const country = document.getElementById("country")!;
    country.addEventListener("click", () => {
      if (document.getElementById("lb1")) return;
      const ul = document.createElement("ul");
      ul.id = "lb1"; ul.setAttribute("role", "listbox");
      for (const c of ["India", "United States", "Indonesia"]) {
        const li = document.createElement("li");
        li.setAttribute("role", "option"); li.textContent = c;
        li.addEventListener("click", () => { country.textContent = c; ul.remove(); });
        ul.appendChild(li);
      }
      body.appendChild(ul);
    });
    // search-as-you-type combobox with selected "pills"
    const how = document.getElementById("how") as HTMLInputElement;
    how.addEventListener("input", () => {
      document.getElementById("lb2")?.remove();
      if (!how.value) return;
      const ul = document.createElement("ul");
      ul.id = "lb2";
      for (const o of ["Other", "Other social media", "LinkedIn"].filter((x) => x.toLowerCase().includes(how.value.toLowerCase()))) {
        const li = document.createElement("li");
        li.setAttribute("data-automation-id", "promptOption"); li.textContent = o;
        li.addEventListener("click", () => {
          how.value = "";
          const pill = document.createElement("div");
          pill.setAttribute("data-automation-id", "selectedItem"); pill.textContent = o;
          how.parentElement!.appendChild(pill);
          ul.remove();
        });
        ul.appendChild(li);
      }
      body.appendChild(ul);
    });
    trap("button");
  });

  it("detects them, strips 'Select Required' from labels, and marks them required", () => {
    const { fields } = scanPage();
    const country = fields.find((f) => f.label === "Country")!;
    expect(country.kind).toBe("dropdown");
    expect(country.required).toBe(true);
    expect(country.filled).toBe(false);
    expect(fields.find((f) => f.label === "How Did You Hear About Us?")?.kind).toBe("dropdown");
  });

  it("opens the list and picks the right option, preferring the exact match", async () => {
    const { fields } = scanPage();
    const { instructions } = await planFill({ fields, context: ctx, resumeText: "x".repeat(300), profile, llm: noLlm });
    const out = await fillPage(instructions);
    expect(document.getElementById("country")!.textContent).toBe("India");
    expect(document.querySelector('[data-automation-id="selectedItem"]')?.textContent).toBe("Other");
    expect(out.every((o) => o.applied)).toBe(true);
    expect(events).not.toContain("click:Submit"); // opening the dropdown itself is expected
    expect(events).not.toContain("submit");
  });

  it("leaves a dropdown for you when no option clearly matches", async () => {
    const { fields } = scanPage();
    const country = fields.find((f) => f.label === "Country")!;
    const out = await fillPage([{ id: country.id, status: "profile", value: "Atlantis" }]);
    expect(out[0].applied).toBe(false);
    expect(document.getElementById("country")!.textContent).toBe("Select One");
  });
});

// ---------------------------------------------------------------------------
describe("Work Experience and Education sections", () => {
  const work: WorkEntry[] = [
    { title: "Programmer Analyst Trainee", company: "Cognizant", location: null, startMonth: 7, startYear: 2025, endMonth: null, endYear: null, current: true, description: "- Built .NET APIs" },
    { title: "Virtual Research and Development Intern", company: "Samsung R&D", location: "Chennai", startMonth: 6, startYear: 2023, endMonth: 2, endYear: 2024, current: false, description: "- Built a DICOM pipeline" },
  ];
  const edu: EduEntry[] = [
    { school: "SRM Institute of Science and Technology", degree: "Bachelor of Technology", field: "Computer Science and Engineering", gpa: "8.47/10", startYear: 2021, endYear: 2025 },
  ];

  beforeEach(() => {
    document.body.innerHTML = `<form>
      <section><h3>Work Experience</h3><div id="exp"></div><button id="addExp" type="button" aria-label="Add Work Experience">Add</button></section>
      <section><h3>Education</h3><div id="edu"></div><button id="addEdu" type="button" aria-label="Add Education">Add</button></section>
      <button id="submit" type="submit">Submit</button></form>`;
    let w = 0, e = 0;
    document.getElementById("addExp")!.addEventListener("click", () => {
      const n = ++w;
      const d = document.createElement("div");
      d.setAttribute("data-automation-id", `workExperience-${n}`);
      d.innerHTML = `<h4>Work Experience ${n}</h4>
        <label for="jt${n}">Job Title*</label><input id="jt${n}"/>
        <label for="co${n}">Company*</label><input id="co${n}"/>
        <label for="lo${n}">Location</label><input id="lo${n}"/>
        <label><input type="checkbox" id="cur${n}"/> I currently work here</label>
        <fieldset><legend>From*</legend><input aria-label="Month" id="fm${n}"/><input aria-label="Year" id="fy${n}"/></fieldset>
        <fieldset><legend>To</legend><input aria-label="Month" id="tm${n}"/><input aria-label="Year" id="ty${n}"/></fieldset>
        <label for="ds${n}">Role Description</label><textarea id="ds${n}"></textarea>`;
      document.getElementById("exp")!.appendChild(d);
    });
    document.getElementById("addEdu")!.addEventListener("click", () => {
      const n = ++e;
      const d = document.createElement("div");
      d.setAttribute("data-automation-id", `education-${n}`);
      d.innerHTML = `<h4>Education ${n}</h4>
        <label for="sc${n}">School or University*</label><input id="sc${n}"/>
        <label for="fs${n}">Field of Study</label><input id="fs${n}"/>
        <label for="gp${n}">Overall Result (GPA)</label><input id="gp${n}"/>
        <fieldset><legend>From</legend><input aria-label="Year" id="ey${n}"/></fieldset>
        <fieldset><legend>To (Actual or Expected)</legend><input aria-label="Year" id="ez${n}"/></fieldset>`;
      document.getElementById("edu")!.appendChild(d);
    });
    trap("button");
  });

  async function fillEntry(kind: "experience" | "education", i: number, entry: WorkEntry | EduEntry) {
    const prep = await prepareSection(kind, i);
    expect(prep.ok).toBe(true);
    const { fields } = scanPage(prep.scope);
    const instructions = planEntry(kind, entry, fields);
    return { fields, instructions, out: await fillPage(instructions) };
  }
  const v = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

  it("adds entries with the section's own Add button and copies them from the resume", async () => {
    expect((await prepareSection("experience", 0, true)).ok).toBe(true);
    await fillEntry("experience", 0, work[0]);
    await fillEntry("experience", 1, work[1]);
    expect(v("jt1")).toBe("Programmer Analyst Trainee");
    expect(v("co1")).toBe("Cognizant");
    expect((document.getElementById("cur1") as HTMLInputElement).checked).toBe(true);
    expect([v("fm1"), v("fy1")]).toEqual(["07", "2025"]);
    expect([v("tm1"), v("ty1")]).toEqual(["", ""]); // "to" left alone for a current job
    expect(v("ds1")).toBe("- Built .NET APIs");
    expect(v("jt2")).toBe("Virtual Research and Development Intern");
    expect(v("lo2")).toBe("Chennai");
    expect([v("fm2"), v("fy2"), v("tm2"), v("ty2")]).toEqual(["06", "2023", "02", "2024"]);
    expect((document.getElementById("cur2") as HTMLInputElement).checked).toBe(false);
    expect(document.querySelectorAll('[data-automation-id^="workExperience-"]')).toHaveLength(2);
  });

  it("does not add duplicate entries when run again", async () => {
    await fillEntry("experience", 0, work[0]);
    await fillEntry("experience", 0, work[0]);
    expect(document.querySelectorAll('[data-automation-id^="workExperience-"]')).toHaveLength(1);
  });

  it("fills education, with the GPA as a number", async () => {
    await fillEntry("education", 0, edu[0]);
    expect(v("sc1")).toBe("SRM Institute of Science and Technology");
    expect(v("fs1")).toBe("Computer Science and Engineering");
    expect(v("gp1")).toBe("8.47");
    expect([v("ey1"), v("ez1")]).toEqual(["2021", "2025"]);
  });

  it("never clicks Submit while doing any of this", async () => {
    await fillEntry("experience", 0, work[0]);
    await fillEntry("education", 0, edu[0]);
    expect(events.filter((x) => /submit/i.test(x))).toEqual([]);
    expect(events).not.toContain("submit");
  });

  it("reports a missing section without touching anything", async () => {
    document.body.innerHTML = `<form><input id="x"/></form>`;
    expect((await prepareSection("experience", 0)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("advancePage safety", () => {
  it("clicks Save and Continue but never Submit or Apply", () => {
    document.body.innerHTML = `<form><button>Back</button><button>Apply</button><button>Submit application</button><button>Save and Continue</button></form>`;
    trap("button");
    const r = advancePage();
    expect(r).toEqual({ clicked: true, label: "save and continue" });
    // Only the Next button is clicked; Submit and Apply never are. (A Next button that is a
    // submit button in a plain form submits that one step, which is how Next works.)
    expect(events.filter((e) => e.startsWith("click:"))).toEqual(["click:Save and Continue"]);
  });

  it("refuses when only Submit or Apply is left", () => {
    document.body.innerHTML = `<form><button>Back</button><button>Submit</button></form>`;
    trap("button");
    const r = advancePage();
    expect(r.clicked).toBe(false);
    expect(r.reason).toMatch(/submit it yourself/i);
    expect(events).toEqual([]);
  });

  it("does not treat lookalike labels as Next", () => {
    document.body.innerHTML = `<button>Submit and continue</button><button>Next steps: apply now</button><button disabled>Next</button>`;
    trap("button");
    expect(advancePage().clicked).toBe(false);
    expect(events).toEqual([]);
  });

  it("pageSignature changes when the visible step changes", () => {
    document.body.innerHTML = `<h2>My Information</h2><input name="a"/>`;
    const a = pageSignature();
    document.body.innerHTML = `<h2>My Experience</h2><input name="b"/>`;
    expect(pageSignature()).not.toBe(a);
  });
});
