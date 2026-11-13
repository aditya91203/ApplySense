import type { Profile } from "./storage";

export interface MatchResult {
  key: string;
  /** null = a known question, but the profile has no answer. Never guess. */
  value: string | null;
}

export const norm = (s: string) =>
  s.toLowerCase().replace(/[*:?]/g, " ").replace(/\s+/g, " ").trim();

const RULES: { key: string; test: RegExp }[] = [
  { key: "firstName", test: /\bfirst name\b|given name/ },
  { key: "lastName", test: /\blast name\b|surname|family name/ },
  { key: "fullName", test: /\bfull name\b|^name$|^your name$|^candidate name$|^applicant name$/ },
  // specific phone parts before the generic phone rule
  { key: "phoneCountryCode", test: /country phone code|phone country|country code|dial(l)?ing code|phone code/ },
  { key: "phoneDeviceType", test: /phone device type|device type|phone type/ },
  { key: "email", test: /e-?mail/ },
  { key: "phone", test: /phone number|^phone$|mobile( number| no)?$|contact number|whatsapp|telephone/ },
  { key: "addressLine1", test: /address line 1|address 1|street( address)?$|^address$/ },
  { key: "addressLine2", test: /address line 2|address 2/ },
  { key: "postalCode", test: /postal code|zip( code)?|pin ?code/ },
  { key: "state", test: /^state( province)?$|^state\/province$|^province$|^region$/ },
  { key: "country", test: /^country( region)?$|^country\/region$|country of residence/ },
  { key: "howHeard", test: /how did you hear|how (do|did) you (find|learn)|where did you (hear|find|learn)|referral source|^source$/ },
  { key: "workAuthorized", test: /legally (eligible|authori[sz]ed|entitled|permitted)|eligible to work|authori[sz]ed to work|right to work|work authori[sz]ation/ },
  { key: "meetsMinimumAge", test: /minimum (working )?age|legal (working )?age|at least 18|18 years|of legal age/ },
  { key: "previouslyEmployed", test: /(previously|ever|formerly) (worked|employed)|currently employed in any capacity|former (employee|worker)|previous(ly)? employee/ },
  { key: "graduationYear", test: /year of (graduation|passing|completion)|graduation year|passing year|pass(ing)? ?out year/ },
  { key: "cgpa", test: /\b(cgpa|gpa)\b|aggregate (cgpa|score)/ },
  { key: "school", test: /^(name of )?(the )?(college|university|institute|institution)( name)?$|college\/university|(college|university|institute) (you )?(study|studied|attend|attended|graduated)|^college( or university)?$/ },
  { key: "degree", test: /^degree$|^highest (qualification|degree|education)|^qualification$|^course$|degree (pursuing|pursued)/ },
  { key: "fieldOfStudy", test: /^(branch|stream|specializ?ation|major|field of study|discipline)$|branch of study|branch\/stream|stream\/branch/ },
  { key: "linkedin", test: /linkedin/ },
  { key: "github", test: /github/ },
  { key: "portfolio", test: /portfolio|personal (web)?site|^website$|^website url$/ },
  { key: "currentCompany", test: /current (company|employer|organi[sz]ation)|present (company|employer)|employer name/ },
  { key: "currentTitle", test: /current (job )?(title|designation|role)|^designation$/ },
  { key: "expectedCTC", test: /expected (ctc|salary|compensation|annual)|salary expectation|desired (ctc|salary)/ },
  { key: "currentCTC", test: /current (ctc|salary|compensation|annual)|present (ctc|salary)/ },
  { key: "noticePeriod", test: /notice period|how soon can you join|joining time|available to join|earliest (start|joining)/ },
  { key: "relocate", test: /relocat/ },
  { key: "totalExperience", test: /total (work(ing)? )?experience|overall experience|total years|^(how many )?years of (work )?experience$|^experience( in years)?$/ },
  { key: "city", test: /current (city|location)|\bcity\b|where are you (based|located)|^location$|current residence/ },
];

const EDU_KEYS = new Set(["graduationYear", "cgpa", "school", "degree", "fieldOfStudy"]);
const LOWER_EDU = /\b(10th|12th|tenth|twelfth|ssc|hsc|sslc|secondary|matriculation|diploma|class (x|xii))\b/;

function valueFor(key: string, p: Profile): string | null {
  const parts = p.fullName.trim().split(/\s+/).filter(Boolean);
  const v =
    key === "firstName" ? parts[0] ?? "" :
    key === "lastName" ? parts.slice(1).join(" ") :
    (p as unknown as Record<string, string>)[key] ?? "";
  return v.trim() ? v.trim() : null;
}

/** "C#: 1, .NET: 1.5" style lines; returns the years for the skill named in the label. */
export function skillYearsFor(label: string, skillYears: string): string | null {
  const l = norm(label);
  for (const line of skillYears.split(/[\n;,]+/)) {
    const m = line.match(/^(.+?)\s*[:=-]\s*([\d.]+)/);
    if (m && l.includes(norm(m[1]))) return m[2];
  }
  return null;
}

/** "question phrase => answer" lines the person wrote; they win over the built-in rules. */
export function matchCustom(label: string, customAnswers: string): string | null {
  const l = norm(label);
  for (const line of customAnswers.split("\n")) {
    const i = line.indexOf("=>");
    if (i < 1) continue;
    const phrase = norm(line.slice(0, i));
    const answer = line.slice(i + 2).trim();
    if (phrase && answer && l.includes(phrase)) return answer;
  }
  return null;
}

export function matchProfile(label: string, p: Profile): MatchResult | null {
  const l = norm(label);
  const custom = matchCustom(label, p.customAnswers);
  if (custom !== null) return { key: "custom", value: custom };
  for (const r of RULES) {
    if (!r.test.test(l)) continue;
    // School-level questions ("10th percentage", "12th CGPA") must never get your college details.
    if (EDU_KEYS.has(r.key) && LOWER_EDU.test(l)) return { key: r.key, value: null };
    return { key: r.key, value: valueFor(r.key, p) };
  }
  if (/\b(years?|yrs?)\b/.test(l) && /\bexp/.test(l)) {
    return { key: "skillYears", value: skillYearsFor(l, p.skillYears) };
  }
  return null;
}

/** Map a value onto one of a field's real options, or null if it is not unambiguously one of them. */
export function chooseOption(value: string, options: string[]): string | null {
  const v = norm(value);
  if (!v) return null;
  const exact = options.find((o) => norm(o) === v);
  if (exact) return exact;

  if (/^[\d.]+$/.test(v)) {
    const n = parseFloat(v);
    const hits = options.filter((o) => {
      const range = o.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
      if (range) return n >= parseFloat(range[1]) && n <= parseFloat(range[2]);
      const plus = o.match(/(\d+(?:\.\d+)?)\s*\+/);
      return plus ? n >= parseFloat(plus[1]) : false;
    });
    return hits.length === 1 ? hits[0] : null;
  }
  if (v === "yes" || v === "no") {
    const o = options.find((x) => norm(x).startsWith(v));
    if (o) return o;
  }
  const contains = options.filter((o) => norm(o).includes(v) || (norm(o).length > 2 && v.includes(norm(o))));
  return contains.length === 1 ? contains[0] : null;
}

/** Questions ApplyCraft never answers: sensitive, legal or consent. Left highlighted for the person. */
export const PROTECTED =
  /gender|\brace\b|ethnic|disabilit|veteran|religio|caste|sexual|marital|date of birth|\bdob\b|aadhaar|aadhar|\bpan\b|passport|\bssn\b|agree|consent|terms|certify|acknowledge|privacy policy|declar|signature|e-?sign/;
