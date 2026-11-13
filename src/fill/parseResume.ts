import type { Profile } from "../shared/storage";
import type { EduEntry, ResumeEntries, WorkEntry } from "./entries";

/*
 * Reads Work Experience and Education straight out of resume text with rules. No AI, no network.
 * Built for the usual layout:
 *     Job title | Jan 2024 – Present
 *     Company | Location
 *     - bullet
 * and
 *     School | City
 *     Degree in Field; GPA: 8.5/10 | 2021 – 2025
 * Pasted-from-PDF text (columns separated by runs of spaces, wrapped bullets) works too.
 */

const MON = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const RANGE = new RegExp(
  `(?:(?<sm>${MON})\\.?,?\\s+)?(?<sy>(?:19|20)\\d{2})\\s*(?:–|—|-|to)\\s*` +
  `(?:(?<pres>present|current|now|ongoing|till date)|(?:(?<em>${MON})\\.?,?\\s+)?(?<ey>(?:19|20)\\d{2}))`,
  "i",
);
const BULLET = /^\s*[-•*▪●◦·]\s*/;
const SECTION = /^(summary|profile|objective|(?:technical |key )?skills|experience|work experience|professional experience|employment(?: history)?|projects?|education|academic(?: background| qualifications)?|certifications?|achievements?|awards|publications|languages|interests|references)\s*:?$/i;
const MODE = /^(on-?site|remote|hybrid|full[- ]?time|part[- ]?time|contract|internship)$/i;

interface Range {
  index: number;
  startMonth: number | null;
  startYear: number;
  endMonth: number | null;
  endYear: number | null;
  current: boolean;
}

const mnum = (s?: string) => (s ? MONTH_INDEX[s.slice(0, 3).toLowerCase()] ?? null : null);

function matchRange(line: string): Range | null {
  const m = RANGE.exec(line);
  if (!m || !m.groups) return null;
  const g = m.groups;
  return {
    index: m.index,
    startMonth: mnum(g.sm),
    startYear: Number(g.sy),
    endMonth: g.pres ? null : mnum(g.em),
    endYear: g.pres || !g.ey ? null : Number(g.ey),
    current: !!g.pres,
  };
}

const splitParts = (s: string) => s.split(/\s+\|\s+|\s{3,}/).map((x) => x.trim()).filter(Boolean);
const tidy = (s: string) => s.replace(/[\s|,(–—-]+$/, "").replace(/^[\s|]+/, "").trim();

function splitDegree(t: string): { degree: string; field: string | null } {
  const mIn = t.match(/^(.*?)\s+in\s+(.+)$/i);
  if (mIn) return { degree: mIn[1].trim(), field: mIn[2].trim() };
  const mPar = t.match(/^(.*?)\s*\((.+)\)$/);
  if (mPar) return { degree: mPar[1].trim(), field: mPar[2].trim() };
  const mCom = t.match(/^([^,]+),\s*(.+)$/);
  if (mCom) return { degree: mCom[1].trim(), field: mCom[2].trim() };
  return { degree: t.trim(), field: null };
}

function sections(text: string): { experience: string[]; education: string[] } {
  const out = { experience: [] as string[], education: [] as string[] };
  let cur: keyof typeof out | null = null;
  for (const raw of text.replace(/\f/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ").replace(/\s+$/, "");
    const bare = line.trim();
    if (bare && SECTION.test(bare)) {
      cur = /experience|employment/i.test(bare) ? "experience" : /education|academic/i.test(bare) ? "education" : null;
      continue;
    }
    if (cur && bare) out[cur].push(line.trim());
  }
  return out;
}

const isHeader = (l: string) => !BULLET.test(l) && l.length < 220 && !!matchRange(l);

function parseExperience(lines: string[]): WorkEntry[] {
  const heads = lines.map((l, i) => (isHeader(l) ? i : -1)).filter((i) => i >= 0);
  const entries: WorkEntry[] = [];
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1] : lines.length;
    const r = matchRange(lines[h])!;
    const title = tidy(lines[h].slice(0, r.index));
    const rest = lines.slice(h + 1, end);

    let i = 0;
    let company = "";
    let location: string | null = null;
    if (rest.length && !BULLET.test(rest[0])) {
      const parts = splitParts(rest[0]);
      company = parts[0] ?? "";
      const loc = parts[1];
      location = loc && !MODE.test(loc) ? loc : null;
      i = 1;
    }

    const bullets: string[] = [];
    for (; i < rest.length; i++) {
      const l = rest[i];
      if (BULLET.test(l)) bullets.push(l.replace(BULLET, "").trim());
      else if (bullets.length) bullets[bullets.length - 1] += ` ${l.trim()}`; // wrapped line
    }
    if (!title || !company) return;
    entries.push({
      title, company, location,
      startMonth: r.startMonth, startYear: r.startYear,
      endMonth: r.endMonth, endYear: r.endYear,
      current: r.current,
      description: bullets.map((b) => `- ${b}`).join("\n"),
    });
  });
  return entries;
}

function parseEducation(lines: string[]): EduEntry[] {
  const heads = lines.map((l, i) => (isHeader(l) ? i : -1)).filter((i) => i >= 0);
  const entries: EduEntry[] = [];
  for (const h of heads) {
    const schoolLine = lines[h - 1];
    if (!schoolLine || BULLET.test(schoolLine) || isHeader(schoolLine)) continue;
    const r = matchRange(lines[h])!;
    const before = tidy(lines[h].slice(0, r.index));
    const school = splitParts(schoolLine)[0];
    const gm = before.match(/\b(?:c?gpa|percentage|percent|score|grade)\b\s*:?\s*([\d.]+(?:\s*\/\s*\d+)?)/i);
    const { degree, field } = splitDegree(before.split(";")[0]);
    if (!school) continue;
    entries.push({
      school, degree, field,
      gpa: gm ? gm[1].replace(/\s+/g, "") : null,
      startYear: r.startYear,
      endYear: r.endYear,
    });
  }
  return entries;
}

export function parseResume(text: string): ResumeEntries {
  const s = sections(text);
  return { experience: parseExperience(s.experience), education: parseEducation(s.education) };
}

export const isEmptyEntries = (e: ResumeEntries) => !e.experience.length && !e.education.length;

const HIGHER = /bachelor|master|b\.?\s?tech|m\.?\s?tech|\bb\.?e\b|\bb\.?sc|\bm\.?sc|\bmba\b|\bphd\b|\bdiploma\b/i;

/**
 * Fills blank profile fields from the resume so questions like "College", "Degree", "CGPA",
 * "Year of graduation" can be answered without typing them twice. Anything you typed wins.
 */
export function withResumeFacts(profile: Profile, entries: ResumeEntries): Profile {
  const out = { ...profile };
  const edu = entries.education.find((e) => HIGHER.test(e.degree)) ?? entries.education[0];
  if (edu) {
    if (!out.school) out.school = edu.school;
    if (!out.degree) out.degree = edu.degree;
    if (!out.fieldOfStudy && edu.field) out.fieldOfStudy = edu.field;
    if (!out.cgpa && edu.gpa) out.cgpa = edu.gpa.match(/\d+(?:\.\d+)?/)?.[0] ?? edu.gpa;
    if (!out.graduationYear && edu.endYear) out.graduationYear = String(edu.endYear);
  }
  const job = entries.experience.find((e) => e.current);
  if (job) {
    if (!out.currentCompany) out.currentCompany = job.company;
    if (!out.currentTitle) out.currentTitle = job.title;
  }
  return out;
}
