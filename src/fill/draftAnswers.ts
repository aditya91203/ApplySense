import { z } from "zod";
import type { LlmProvider } from "../llm/provider";
import type { PageContext, ScannedField } from "../shared/types";
import type { Profile } from "../shared/storage";
import { chooseOption } from "../shared/profileMatch";

const Schema = z.object({
  answers: z.array(z.object({ id: z.string(), answer: z.string().nullable() })),
});

const SYSTEM = `You fill in job application questions for a candidate.
FACTS: use ONLY the CANDIDATE PROFILE and RESUME below. Never invent employers, projects, metrics, skills, dates, salary, notice period, visa or work-authorisation status, or years of experience.
If the facts do not support an answer, set "answer" to null. Do not guess.
For select/radio questions, "answer" must be EXACTLY one of the listed options, otherwise null.
For open-ended questions (why this role, strengths, describe a project): 2-4 sentences, first person, plain and specific, drawing on real resume experience. When the candidate's experience is adjacent rather than direct, bridge from the closest real experience; never claim outcomes the resume does not state.
Respect any maxLength. Mention a company name only if the question or the page context names it.
Return JSON only: {"answers":[{"id":string,"answer":string|null}]}`;

export interface DraftInput {
  fields: ScannedField[];
  context: PageContext;
  resumeText: string;
  profile: Profile;
}

function trimTo(text: string, max?: number): string {
  if (!max || text.length <= max) return text;
  const cut = text.slice(0, max);
  const sentence = cut.lastIndexOf(".");
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trim();
}

export async function draftAnswers(llm: LlmProvider, input: DraftInput): Promise<Map<string, string>> {
  const { fields, context, resumeText, profile } = input;
  // Salary, contact details and home address are deliberately never sent to the model.
  const PRIVATE = new Set(["currentCTC", "expectedCTC", "email", "phone", "addressLine1", "addressLine2", "postalCode", "customAnswers"]);
  const facts = Object.entries(profile)
    .filter(([k, v]) => v.trim() && !PRIVATE.has(k))
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const questions = fields.map((f) => ({
    id: f.id,
    question: f.label,
    type: f.kind,
    ...(f.options ? { options: f.options } : {}),
    ...(f.maxLength ? { maxLength: f.maxLength } : {}),
  }));

  const prompt = `PAGE: ${context.title} | ${context.heading}
JOB PAGE TEXT (may include the job description):
"""${context.pageText}"""

CANDIDATE PROFILE:
${facts || "(none)"}

RESUME:
"""${resumeText}"""

QUESTIONS:
${JSON.stringify(questions, null, 1)}`;

  const { answers } = await llm.completeJson({ system: SYSTEM, prompt, schema: Schema });

  const byId = new Map(fields.map((f) => [f.id, f]));
  const out = new Map<string, string>();
  for (const a of answers) {
    const f = byId.get(a.id);
    if (!f || !a.answer || !a.answer.trim()) continue;
    if (f.kind === "select" || f.kind === "radio") {
      const opt = chooseOption(a.answer, f.options ?? []);
      if (opt) out.set(f.id, opt); // an answer that is not one of the real options is dropped
    } else {
      out.set(f.id, trimTo(a.answer.trim(), f.maxLength));
    }
  }
  return out;
}
