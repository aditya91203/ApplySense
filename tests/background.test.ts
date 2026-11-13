import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/shared/job";

const resume = readFileSync(resolve(process.cwd(), "tests/fixtures/resume-swe-clean.txt"), "utf8");
const seed = JSON.parse(readFileSync(resolve(process.cwd(), "tests/fixtures/profile.json"), "utf8")) as Record<string, string>;

type Listener = (msg: unknown, sender: unknown, respond: (r?: unknown) => void) => boolean | void;

/** A fake `chrome` whose executeScript runs the real injected functions against the jsdom page. */
function installChrome(settings: Record<string, unknown>) {
  const store: Record<string, unknown> = { ...settings };
  let listener: Listener | undefined;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (k?: string | string[] | null) => {
          if (k == null) return { ...store };
          const keys = typeof k === "string" ? [k] : k;
          return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, store[x]]));
        },
        set: async (o: Record<string, unknown>) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
      },
    },
    runtime: { onMessage: { addListener: (fn: Listener) => { listener = fn; } } },
    tabs: { get: async (id: number) => ({ id, title: document.title || "Application form" }) },
    scripting: {
      executeScript: async (inj: { func: (...a: unknown[]) => unknown; args?: unknown[] }) => [
        { frameId: 0, result: await inj.func(...(inj.args ?? [])) },
      ],
    },
  });
  const send = (msg: unknown) => new Promise<unknown>((res) => { listener!(msg, {}, res); });
  return { store, send, job: () => store.job as Job | undefined };
}

const settings = (extra: Record<string, unknown> = {}) => ({
  apiKey: "", // no Gemini key at all
  resumes: [{ name: "SWE", text: resume }],
  profile: seed,
  ...extra,
});

let submits: string[] = [];
const track = () => {
  document.querySelectorAll('button,[role="button"]').forEach((b) =>
    b.addEventListener("click", () => submits.push((b.textContent ?? "").trim())));
};

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = "";
  submits = [];
  // Any network call fails the test: running without a key must be fully offline.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network used"); }));
});
afterEach(() => vi.unstubAllGlobals());

const GOOGLE_PAGE_1 = `<form action="https://docs.google.com/forms/d/e/X/formResponse"><div role="list">
  <div role="listitem"><div role="heading"><span>Full name</span><span aria-label="Required question"> *</span></div><input type="text"/></div>
  <div role="listitem"><div role="heading"><span>Email</span><span aria-label="Required question"> *</span></div><input type="email"/></div>
  </div><div role="button"><span>Next</span></div><div role="button"><span>Submit</span></div></form>`;
const GOOGLE_PAGE_2 = `<form action="https://docs.google.com/forms/d/e/X/formResponse"><div role="list">
  <div role="listitem"><div role="heading"><span>Phone number</span></div><input type="text"/></div>
  <div role="listitem"><div role="heading"><span>Anything else?</span></div><textarea></textarea></div>
  </div><div role="button"><span>Back</span></div><div role="button"><span>Submit</span></div></form>`;

describe("whole run with no API key", () => {
  it("fills page 1, clicks Next, fills page 2, then stops at Submit without clicking it", async () => {
    const c = installChrome(settings());
    await import("../src/background/index");
    document.body.innerHTML = GOOGLE_PAGE_1;
    document.title = "Club application";
    document.querySelectorAll<HTMLElement>('[role="button"]').forEach((b) => {
      if (b.textContent === "Next") b.addEventListener("click", () => { document.body.innerHTML = GOOGLE_PAGE_2; track(); });
    });
    track();

    await c.send({ type: "fill", tabId: 1, resumeIndex: 0, advance: true });

    const job = c.job()!;
    expect(job.state).toBe("done");
    expect(job.steps).toHaveLength(2);
    expect(job.stopReason).toMatch(/submit it yourself/i);
    expect(document.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("9000000000"); // page 2 phone
    expect(submits).toEqual(["Next"]); // Submit was never clicked
    expect(job.report?.needsYou).toEqual(["Anything else?"]); // open question left for you, not sent anywhere
    expect(fetch).not.toHaveBeenCalled();
  }, 20000);

  it("stops at once on a page with required fields it cannot answer", async () => {
    const c = installChrome(settings());
    await import("../src/background/index");
    document.body.innerHTML = `<form action="https://docs.google.com/forms/d/e/X/formResponse"><div role="list">
      <div role="listitem"><div role="heading"><span>Favourite colour</span><span aria-label="Required question"> *</span></div><input type="text"/></div>
      </div><div role="button"><span>Next</span></div></form>`;
    track();
    await c.send({ type: "fill", tabId: 1, resumeIndex: 0, advance: true });
    expect(c.job()!.stopReason).toMatch(/required field/i);
    expect(submits).toEqual([]); // did not even press Next
  });
});

describe("Stop button", () => {
  it("cancels a run that is waiting on a dropdown and reports it as stopped", async () => {
    const c = installChrome(settings());
    await import("../src/background/index");
    document.body.innerHTML = `<form action="https://docs.google.com/forms/d/e/X/formResponse"><div role="list">
      <div role="listitem"><div role="heading"><span>Full name</span></div><input type="text"/></div>
      <div role="listitem"><div role="heading"><span>Country</span></div>
        <button type="button" aria-haspopup="listbox" aria-label="Country Select Required">Select One</button></div>
      </div><div role="button"><span>Next</span></div><div role="button"><span>Submit</span></div></form>`;
    track();

    const running = c.send({ type: "fill", tabId: 1, resumeIndex: 0, advance: true });
    await new Promise((r) => setTimeout(r, 300));
    expect((c.job() as Job).state).toBe("running");
    await c.send({ type: "stop" });
    await running;

    const job = c.job()!;
    expect(job.state).toBe("stopped");
    expect(job.stopReason).toMatch(/nothing was submitted/i);
    expect(submits).not.toContain("Next"); // stopped before moving on
    expect(submits).not.toContain("Submit");
  }, 10000);

  it("clears a stuck 'running' state even when no run is active", async () => {
    const c = installChrome(settings({ job: { state: "running", startedAt: Date.now() - 60000 } }));
    await import("../src/background/index");
    await c.send({ type: "stop" });
    expect(c.job()!.state).toBe("stopped");
  });

  it("does not start a second run while one is active", async () => {
    const c = installChrome(settings());
    await import("../src/background/index");
    document.body.innerHTML = `<form action="https://docs.google.com/forms/d/e/X/formResponse"><div role="list">
      <div role="listitem"><div role="heading"><span>Country</span></div>
      <button type="button" aria-haspopup="listbox" aria-label="Country Select Required">Select One</button></div></div></form>`;
    const first = c.send({ type: "fill", tabId: 1, resumeIndex: 0, advance: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(await c.send({ type: "fill", tabId: 1, resumeIndex: 0, advance: false })).toEqual({ busy: true });
    await c.send({ type: "stop" });
    await first;
  }, 10000);
});

describe("Work Experience / Education without AI", () => {
  it("copies entries from the resume using the parser alone", async () => {
    const c = installChrome(settings());
    await import("../src/background/index");
    document.body.innerHTML = `<form>
      <section><h3>Work Experience</h3><div id="exp"></div><button id="addExp" type="button" aria-label="Add Work Experience">Add</button></section>
      <section><h3>Education</h3><div id="edu"></div><button id="addEdu" type="button" aria-label="Add Education">Add</button></section>
      <label for="loc">Location</label><input id="loc"/>
      <button type="submit">Submit</button></form>`;
    let w = 0, e = 0;
    document.getElementById("addExp")!.addEventListener("click", () => {
      const n = ++w; const d = document.createElement("div");
      d.setAttribute("data-automation-id", `workExperience-${n}`);
      d.innerHTML = `<h4>Work Experience ${n}</h4><label for="jt${n}">Job Title*</label><input id="jt${n}"/>
        <label for="co${n}">Company*</label><input id="co${n}"/><label for="lo${n}">Location</label><input id="lo${n}"/>`;
      document.getElementById("exp")!.appendChild(d);
    });
    document.getElementById("addEdu")!.addEventListener("click", () => {
      const n = ++e; const d = document.createElement("div");
      d.setAttribute("data-automation-id", `education-${n}`);
      d.innerHTML = `<h4>Education ${n}</h4><label for="sc${n}">School or University*</label><input id="sc${n}"/>`;
      document.getElementById("edu")!.appendChild(d);
    });
    track();

    await c.send({ type: "fill", tabId: 1, resumeIndex: 0, advance: false });
    const v = (id: string) => (document.getElementById(id) as HTMLInputElement).value;
    expect([v("jt1"), v("co1")]).toEqual(["Programmer Analyst Trainee", "Cognizant"]);
    expect([v("jt3"), v("co3"), v("lo3")]).toEqual(["Virtual Research and Development Intern", "Samsung R&D", "Online, Chennai"]);
    expect([v("sc1"), v("sc2")]).toEqual(["SRM Institute of Science and Technology", "B.K. Birla Centre for Education"]);
    // A job's empty Location box must not be filled with your home city by the page-wide pass.
    expect([v("lo1"), v("lo2")]).toEqual(["", ""]);
    expect(v("loc")).toBe("Mumbai"); // the separate, real Location field still is
    expect(submits.filter((s) => /submit/i.test(s))).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  }, 15000);
});
