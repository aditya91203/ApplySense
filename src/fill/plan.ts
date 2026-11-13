import type { LlmProvider } from "../llm/provider";
import { chooseOption, matchProfile, norm, PROTECTED } from "../shared/profileMatch";
import type { Profile } from "../shared/storage";
import type { FillInstruction, FillOutcome, FillReport, PageContext, ScannedField } from "../shared/types";
import { draftAnswers } from "./draftAnswers";

export interface PlanInput {
  fields: ScannedField[];
  context: PageContext;
  resumeText: string;
  profile: Profile;
  /** Optional. Without it, open-ended questions are simply left for you. */
  llm?: LlmProvider;
}

const DATE_TYPES = new Set(["date", "datetime-local", "month", "week", "time"]);

/**
 * Decide what goes in each field. Order matters:
 *  1. already filled -> untouched
 *  2. files, checkboxes, dates, sensitive/legal questions -> left for the person
 *  3. known profile questions -> profile value, or left for the person if the profile is blank
 *  4. custom dropdowns -> only from your details (the model never picks from options it cannot see)
 *  5. everything else -> AI draft if a key is set, otherwise left for the person
 */
export async function planFill(input: PlanInput): Promise<{ instructions: FillInstruction[]; aiError?: string }> {
  const { fields, context, resumeText, profile, llm } = input;
  const instructions: FillInstruction[] = [];
  const needsAi: ScannedField[] = [];

  for (const f of fields) {
    if (f.filled) continue;
    const leave = (note: string) => instructions.push({ id: f.id, status: "needs-you", note });

    if (!norm(f.label)) { leave("no label found"); continue; }
    if (f.kind === "file") { leave("upload it yourself"); continue; }
    if (f.kind === "checkbox") { leave("tick it yourself"); continue; }
    if (f.inputType && DATE_TYPES.has(f.inputType)) { leave("date field"); continue; }
    if (PROTECTED.test(norm(f.label))) { leave("sensitive or legal question"); continue; }

    const m = matchProfile(f.label, profile);
    if (f.kind === "dropdown") {
      // Options are unknown until opened, so the model never chooses here.
      if (!m) leave("custom dropdown: choose it yourself");
      else if (m.value === null) leave("not in your profile");
      else instructions.push({ id: f.id, status: "profile", value: m.value });
      continue;
    }
    if (m) {
      if (m.value === null) { leave("not in your profile"); continue; }
      const value = f.options ? chooseOption(m.value, f.options) : m.value;
      if (value) instructions.push({ id: f.id, status: "profile", value });
      else leave("profile value does not match an option");
      continue;
    }
    needsAi.push(f);
  }

  let aiError: string | undefined;
  if (needsAi.length && !llm) {
    for (const f of needsAi) instructions.push({ id: f.id, status: "needs-you", note: "write this one yourself (AI drafting is off)" });
  } else if (needsAi.length && llm) {
    try {
      const answers = await draftAnswers(llm, { fields: needsAi, context, resumeText, profile });
      for (const f of needsAi) {
        const a = answers.get(f.id);
        instructions.push(
          a
            ? { id: f.id, status: "ai", value: a }
            : { id: f.id, status: "needs-you", note: "your resume does not support an answer" },
        );
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      aiError = e instanceof Error ? e.message : String(e);
      for (const f of needsAi) instructions.push({ id: f.id, status: "needs-you", note: "AI drafting failed" });
    }
  }
  return { instructions, aiError };
}

export function buildReport(
  fields: ScannedField[],
  instructions: FillInstruction[],
  outcomes: FillOutcome[],
  aiError?: string,
): FillReport {
  const label = new Map(fields.map((f) => [f.id, f.label || "(unlabelled field)"]));
  const required = new Map(fields.map((f) => [f.id, f.required]));
  const applied = new Map(outcomes.map((o) => [o.id, o.applied]));
  let fromProfile = 0;
  const aiDrafts: FillReport["aiDrafts"] = [];
  const needsYou: string[] = [];
  const blocking: string[] = [];
  for (const ins of instructions) {
    const ok = applied.get(ins.id) ?? false;
    if (ins.status === "profile" && ok) fromProfile++;
    else if (ins.status === "ai" && ok) aiDrafts.push({ label: label.get(ins.id)!, answer: ins.value ?? "" });
    else {
      needsYou.push(label.get(ins.id)!);
      if (required.get(ins.id)) blocking.push(label.get(ins.id)!);
    }
  }
  return { fieldCount: fields.length, fromProfile, aiDrafts, needsYou, blocking, aiError };
}
