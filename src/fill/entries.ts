import { z } from "zod";
import type { LlmProvider } from "../llm/provider";
import { norm } from "../shared/profileMatch";
import type { FillInstruction, ScannedField } from "../shared/types";

const Work = z.object({
  title: z.string(),
  company: z.string(),
  location: z.string().nullish(),
  startMonth: z.number().int().min(1).max(12).nullish(),
  startYear: z.number().int().nullish(),
  endMonth: z.number().int().min(1).max(12).nullish(),
  endYear: z.number().int().nullish(),
  current: z.boolean(),
  description: z.string(),
});
const Edu = z.object({
  school: z.string(),
  degree: z.string(),
  field: z.string().nullish(),
  gpa: z.string().nullish(),
  startYear: z.number().int().nullish(),
  endYear: z.number().int().nullish(),
});
const Schema = z.object({ experience: z.array(Work).max(6), education: z.array(Edu).max(4) });

export type WorkEntry = z.infer<typeof Work>;
export type EduEntry = z.infer<typeof Edu>;
export interface ResumeEntries { experience: WorkEntry[]; education: EduEntry[] }

const SYSTEM = `You copy the Work Experience and Education entries out of a resume into structured JSON.
Copy only what is written. Do not infer, embellish or add anything.
- title, company, location, school, degree, field: copy the wording from the resume.
- description: the entry's bullet points copied VERBATIM, one per line, each starting with "- ". Do not reword.
- Dates: months as 1-12 and years as 4 digits, only if the resume states them. Otherwise null.
- current: true only if the resume says Present or Current for that role.
- gpa: the grade or percentage exactly as written (e.g. "8.47/10"), else null.
- Order entries as they appear. Include internships. Do not invent entries.
Return JSON only: {"experience":[{title,company,location,startMonth,startYear,endMonth,endYear,current,description}],"education":[{school,degree,field,gpa,startYear,endYear}]}`;

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Extract entries with the model, then drop or blank anything the resume does not actually contain. */
export async function extractEntries(llm: LlmProvider, resumeText: string): Promise<ResumeEntries> {
  const raw = await llm.completeJson({ system: SYSTEM, prompt: `RESUME:\n"""\n${resumeText}\n"""`, schema: Schema });
  const hay = flat(resumeText);
  const words = new Set(hay.split(" "));
  const has = (s?: string | null) => !!s && hay.includes(flat(s));
  // A location only counts if it is written right beside that employer, not just somewhere in the resume.
  const nearCompany = (loc?: string | null, company?: string) => {
    if (!loc || !company) return false;
    const l = flat(loc), c = flat(company);
    for (let from = 0, i = hay.indexOf(c, from); i >= 0; i = hay.indexOf(c, from)) {
      if (hay.slice(i, i + c.length + 60).includes(l)) return true;
      from = i + 1;
    }
    return false;
  };
  const yearOk = (y?: number | null) => (y && hay.includes(String(y)) ? y : null);

  const experience = raw.experience
    .filter((e) => has(e.company) && has(e.title))
    .map((e) => {
      const dw = flat(e.description).split(" ").filter(Boolean);
      const grounded = dw.length > 0 && dw.filter((w) => words.has(w)).length / dw.length >= 0.9;
      return {
        ...e,
        location: nearCompany(e.location, e.company) ? e.location : null,
        startYear: yearOk(e.startYear),
        endYear: yearOk(e.endYear),
        current: e.current && /\b(present|current)\b/i.test(resumeText),
        description: grounded ? e.description.trim() : "",
      };
    });

  const education = raw.education
    .filter((e) => has(e.school))
    .map((e) => ({
      ...e,
      degree: has(e.degree) ? e.degree : "",
      field: has(e.field) ? e.field : null,
      gpa: has(e.gpa) ? e.gpa : null,
      startYear: yearOk(e.startYear),
      endYear: yearOk(e.endYear),
    }));

  return { experience, education };
}

// ---- mapping an entry onto the fields of its block -------------------------

const mm = (n: number) => String(n).padStart(2, "0");

function degreeAlternatives(degree: string): string {
  const d = degree.toLowerCase();
  const alts = [degree];
  if (/bachelor|b\.?\s?tech|\bb\.?e\b|b\.?sc/.test(d)) alts.push("Bachelor's Degree", "Bachelor", "Bachelors");
  else if (/master|m\.?\s?tech|m\.?sc|\bmba\b/.test(d)) alts.push("Master's Degree", "Master", "Masters");
  else if (/secondary|high school|cbse|icse|12th|10th/.test(d)) alts.push("High School", "Secondary", "Senior Secondary");
  return alts.join("||");
}

function gpaNumber(g: string): string {
  return g.match(/\d+(?:\.\d+)?/)?.[0] ?? g;
}

/** Which date part a field label means, e.g. "From Month" -> { which: "start", part: "month" }. */
function dateRole(l: string): { which: "start" | "end"; part: "month" | "year" | "both" } | null {
  const which = /\b(from|start)/.test(l) ? "start" : /\b(to|end|until|graduat)/.test(l) ? "end" : null;
  if (!which) return null;
  const part = /month|\bmm\b/.test(l) ? "month" : /year|yyyy/.test(l) ? "year" : "both";
  return { which, part };
}

export function planEntry(kind: "experience" | "education", entry: WorkEntry | EduEntry, fields: ScannedField[]): FillInstruction[] {
  const out: FillInstruction[] = [];
  const isWork = kind === "experience";
  const w = entry as WorkEntry;
  const e = entry as EduEntry;

  for (const f of fields) {
    if (f.filled) continue;
    const l = norm(f.label);
    const put = (value: string | null | undefined, note = "not in your resume") =>
      out.push(value ? { id: f.id, status: "profile", value } : { id: f.id, status: "needs-you", note });

    if (f.kind === "checkbox") {
      if (isWork && /currently|present|still work/.test(l) && w.current) out.push({ id: f.id, status: "profile", value: "checked" });
      continue;
    }
    if (f.kind === "file") continue;

    const date = dateRole(l);
    if (date) {
      const m = date.which === "start" ? (isWork ? w.startMonth : null) : isWork ? w.endMonth : null;
      const y = date.which === "start" ? entry.startYear : entry.endYear;
      if (isWork && date.which === "end" && w.current) continue; // "to" is disabled for a current job
      if (date.part === "month") { if (m) put(mm(m)); else if (isWork) put(null); continue; }
      if (date.part === "year") { put(y ? String(y) : null); continue; }
      put(m && y ? `${mm(m)}/${y}` : y ? String(y) : null);
      continue;
    }

    if (isWork) {
      if (/job title|position|^title$|role title/.test(l)) put(w.title);
      else if (/^company|employer|organi[sz]ation/.test(l)) put(w.company);
      else if (/location|^city/.test(l)) put(w.location);
      else if (/description|responsibilit|duties|summary/.test(l)) put(w.description);
    } else {
      if (/school|university|institution|college/.test(l)) put(e.school);
      else if (/degree|qualification|level of education/.test(l)) put(e.degree ? degreeAlternatives(e.degree) : null);
      else if (/field of study|major|discipline|specializ/.test(l)) put(e.field);
      else if (/gpa|grade|result|percentage|cgpa/.test(l)) put(e.gpa ? gpaNumber(e.gpa) : null);
    }
  }
  return out;
}
