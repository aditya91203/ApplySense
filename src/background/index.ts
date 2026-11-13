import { GeminiProvider } from "../llm/gemini";
import type { LlmProvider } from "../llm/provider";
import { extractEntries, planEntry, type ResumeEntries } from "../fill/entries";
import { isEmptyEntries, parseResume, withResumeFacts } from "../fill/parseResume";
import { buildReport, planFill } from "../fill/plan";
import { advancePage, fillPage, pageSignature, prepareSection, scanPage, setCancelFlag } from "../fill/inject";
import { loadSettings, type Profile } from "../shared/storage";
import type { Job, StepSummary } from "../shared/job";
import type { FillInstruction, FillOutcome, FillReport, PageContext, ScannedField } from "../shared/types";

const MAX_STEPS = 8;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setJob = (job: Job) => chrome.storage.local.set({ job });

class Cancelled extends Error {}

interface ActiveRun {
  cancelled: boolean;
  ctrl: AbortController;
  tabId: number;
}
let active: ActiveRun | null = null;

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Everything done on the current page so far, kept outside the work so Stop can still report it. */
interface PageState {
  fields: ScannedField[];
  instructions: FillInstruction[];
  outcomes: FillOutcome[];
}

const hash = (s: string) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

/** Rules first (free, offline). Gemini is only a fallback for resumes the rules cannot read. */
async function getEntries(resumeText: string, llm?: LlmProvider): Promise<ResumeEntries> {
  const parsed = parseResume(resumeText);
  if (!isEmptyEntries(parsed) || !llm) return parsed;
  const key = `entries:${hash(resumeText)}`;
  const cached = (await chrome.storage.local.get(key))[key] as ResumeEntries | undefined;
  if (cached) return cached;
  try {
    const entries = await extractEntries(llm, resumeText);
    await chrome.storage.local.set({ [key]: entries });
    return entries;
  } catch (e) {
    if (isAbort(e)) throw e;
    return parsed;
  }
}

interface Ctx {
  tabId: number;
  profile: Profile;
  resumeText: string;
  llm?: LlmProvider;
  entries: ResumeEntries;
  state: PageState;
  phase: (text: string) => Promise<void>;
}

const check = () => {
  if (active?.cancelled) throw new Cancelled();
};

/** Waits, but wakes up quickly when Stop is pressed. */
async function wait(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    check();
    await sleep(Math.min(100, Math.max(1, end - Date.now())));
  }
  check();
}

async function fillCurrentPage(c: Ctx): Promise<{ report: FillReport; heading: string }> {
  const { tabId, state } = c;
  state.fields.length = 0;
  state.instructions.length = 0;
  state.outcomes.length = 0;
  let sectionError: string | undefined;

  // 1. Work Experience and Education sections, copied from the resume.
  const labels = { experience: "Work Experience", education: "Education" } as const;
  for (const kind of ["experience", "education"] as const) {
    check();
    const list = c.entries[kind];
    if (!list.length) continue;
    const dry = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: prepareSection, args: [kind, 0, true] });
    if (!dry.some((r) => r.result?.ok)) continue; // no such section on this page

    for (let i = 0; i < list.length; i++) {
      check();
      await c.phase(`Filling ${labels[kind]} ${i + 1} of ${list.length}`);
      const prep = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: prepareSection, args: [kind, i] });
      check();
      const hit = prep.find((r) => r.result?.ok && r.result.scope);
      if (!hit?.result?.scope) {
        sectionError = `${labels[kind]}: ${prep.map((r) => r.result?.note).find(Boolean) ?? "could not add another entry"}`;
        break;
      }
      const scan = await chrome.scripting.executeScript({ target: { tabId, frameIds: [hit.frameId] }, func: scanPage, args: [hit.result.scope] });
      const fields = scan[0]?.result?.fields ?? [];
      const instructions = planEntry(kind, list[i], fields);
      state.fields.push(...fields);
      state.instructions.push(...instructions);
      const res = await chrome.scripting.executeScript({ target: { tabId, frameIds: [hit.frameId] }, func: fillPage, args: [instructions] });
      state.outcomes.push(...(res[0]?.result ?? []));
    }
  }

  // 2. Everything else on the page.
  check();
  await c.phase("Reading the page");
  let scans;
  try {
    scans = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanPage });
  } catch {
    throw new Error("ApplyCraft cannot read this page. Open the application form in a normal tab (not a chrome:// page or the Web Store).");
  }
  check();
  const tab = await chrome.tabs.get(tabId);
  const fields: ScannedField[] = [];
  const frameOf = new Map<string, number>();
  let context: PageContext = { title: tab.title ?? "", heading: "", pageText: "" };
  for (const r of scans) {
    if (!r.result) continue;
    for (const f of r.result.fields) {
      fields.push(f);
      frameOf.set(f.id, r.frameId);
    }
    if (r.frameId === 0) context = r.result.context;
  }

  await c.phase(c.llm ? "Working out answers" : "Matching your details");
  const { instructions, aiError } = await planFill({ fields, context, resumeText: c.resumeText, profile: c.profile, llm: c.llm });
  check();
  state.fields.push(...fields);
  state.instructions.push(...instructions);

  await c.phase("Filling fields");
  const byFrame = new Map<number, FillInstruction[]>();
  for (const ins of instructions) {
    const frame = frameOf.get(ins.id);
    if (frame !== undefined) byFrame.set(frame, [...(byFrame.get(frame) ?? []), ins]);
  }
  for (const [frameId, list] of byFrame) {
    const res = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: fillPage, args: [list] });
    state.outcomes.push(...(res[0]?.result ?? []));
    check();
  }

  return {
    report: buildReport(state.fields, state.instructions, state.outcomes, aiError ?? sectionError),
    heading: context.heading || context.title,
  };
}

async function signature(tabId: number): Promise<string> {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageSignature });
    return r[0]?.result ?? "";
  } catch {
    return "navigating";
  }
}

/**
 * Fills the current page. With advance, keeps going to the next page while it is safe to:
 * it stops when required fields still need you, when drafts need your review, when the only
 * button left is Submit/Apply, or when the page does not move on. Stop cancels at any point.
 */
async function run(tabId: number, resumeIndex: number, advance: boolean): Promise<void> {
  const me: ActiveRun = { cancelled: false, ctrl: new AbortController(), tabId };
  active = me;
  const startedAt = Date.now();
  const steps: StepSummary[] = [];
  const state: PageState = { fields: [], instructions: [], outcomes: [] };
  let pageTitle: string | undefined;
  let lastReport: FillReport | undefined;

  const write = (patch: Partial<Job> & { state: Job["state"] }) =>
    setJob({ startedAt, page: pageTitle, advance, steps, ...patch });
  const phase = (text: string) => write({ state: "running", phase: text, report: lastReport });

  try {
    const s = await loadSettings();
    const resume = s.resumes[resumeIndex];
    if (!resume || resume.text.trim().length < 200) throw new Error("That resume slot is empty. Paste its text in Options.");

    const llm = s.apiKey.trim() ? new GeminiProvider(s.apiKey.trim(), s.model, me.ctrl.signal) : undefined;
    const tab = await chrome.tabs.get(tabId);
    pageTitle = tab.title;
    await phase("Starting");
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: setCancelFlag, args: [false] }).catch(() => {});

    const entries = await getEntries(resume.text, llm);
    check();
    const ctx: Ctx = {
      tabId, llm, entries, state, phase,
      profile: withResumeFacts(s.profile, entries),
      resumeText: resume.text,
    };

    let stopReason: string | undefined;
    for (let step = 0; step < (advance ? MAX_STEPS : 1); step++) {
      const result = await fillCurrentPage(ctx);
      const report = (lastReport = result.report);
      steps.push({
        page: result.heading || `Page ${step + 1}`,
        filled: report.fromProfile + report.aiDrafts.length,
        drafts: report.aiDrafts.length,
        needsYou: report.needsYou,
        blocking: report.blocking,
      });
      if (!advance) break;

      if (report.blocking.length) {
        stopReason = `Stopped: ${report.blocking.length} required field(s) need you (orange). Complete them, then run again.`;
        break;
      }
      if (report.aiDrafts.length) {
        stopReason = "Stopped: review the blue drafts on this page, then run again to continue.";
        break;
      }

      await phase("Moving to the next page");
      const before = await signature(tabId);
      check();
      const adv = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: advancePage });
      const clicked = adv.find((r) => r.result?.clicked);
      if (!clicked) {
        stopReason = adv.map((r) => r.result?.reason).find(Boolean) ?? "No Next button found.";
        break;
      }
      let moved = false;
      for (let i = 0; i < 16 && !moved; i++) {
        await wait(500);
        moved = (await signature(tabId)) !== before;
      }
      if (!moved) {
        stopReason = "The page did not move on. Check the highlighted fields for errors.";
        break;
      }
      await wait(1000); // let the next step finish rendering
      if (step === MAX_STEPS - 1) stopReason = `Stopped after ${MAX_STEPS} pages.`;
    }

    await write({ state: "done", report: lastReport, stopReason });
  } catch (e) {
    if (me.cancelled || e instanceof Cancelled || isAbort(e)) {
      const partial = state.instructions.length
        ? buildReport(state.fields, state.instructions, state.outcomes)
        : lastReport;
      await write({ state: "stopped", report: partial, stopReason: "Stopped by you. Nothing was submitted." });
    } else {
      await write({ state: "error", report: lastReport, error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    if (active === me) active = null;
  }
}

async function stopRun(): Promise<void> {
  const me = active;
  if (me) {
    me.cancelled = true;
    me.ctrl.abort();
    // Interrupts a fill that is already running inside the page.
    await chrome.scripting
      .executeScript({ target: { tabId: me.tabId, allFrames: true }, func: setCancelFlag, args: [true] })
      .catch(() => {});
    return;
  }
  // No run in this worker (it may have restarted): just clear a stuck "running" state.
  const { job } = (await chrome.storage.local.get("job")) as { job?: Job };
  if (job?.state === "running") await setJob({ ...job, state: "stopped", phase: undefined, stopReason: "Stopped by you." });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "fill" && typeof msg.tabId === "number") {
    if (active) { sendResponse({ busy: true }); return false; }
    void run(msg.tabId, Number(msg.resumeIndex) || 0, !!msg.advance).finally(() => sendResponse({}));
    return true; // keeps the worker alive until the run finishes
  }
  if (msg?.type === "stop") {
    void stopRun().finally(() => sendResponse({}));
    return true;
  }
  return false;
});
