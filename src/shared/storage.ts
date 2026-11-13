export interface Profile {
  fullName: string;
  email: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phoneDeviceType: string;
  phoneCountryCode: string;
  howHeard: string;
  workAuthorized: string;
  meetsMinimumAge: string;
  previouslyEmployed: string;
  /** Blank = taken from the selected resume. */
  school: string;
  degree: string;
  fieldOfStudy: string;
  cgpa: string;
  graduationYear: string;
  /** One per line: "question phrase => answer". Matched against the form label. */
  customAnswers: string;
  linkedin: string;
  github: string;
  portfolio: string;
  currentCompany: string;
  currentTitle: string;
  totalExperience: string;
  noticePeriod: string;
  currentCTC: string;
  expectedCTC: string;
  relocate: string;
  skillYears: string;
  extraFacts: string;
}

export interface Resume {
  name: string;
  text: string;
}

export interface Settings {
  apiKey: string;
  /** One or more Gemini model IDs, comma-separated, tried in order. */
  model: string;
  resumes: Resume[];
  activeResume: number;
  profile: Profile;
}

export const DEFAULT_MODEL = "gemini-2.5-flash, gemini-2.5-flash-lite";

export const EMPTY_PROFILE: Profile = {
  fullName: "", email: "", phone: "", addressLine1: "", addressLine2: "", city: "", state: "", postalCode: "",
  country: "", phoneDeviceType: "", phoneCountryCode: "", howHeard: "", workAuthorized: "",
  meetsMinimumAge: "", previouslyEmployed: "", customAnswers: "", school: "", degree: "", fieldOfStudy: "", cgpa: "", graduationYear: "", linkedin: "", github: "", portfolio: "",
  currentCompany: "", currentTitle: "", totalExperience: "", noticePeriod: "",
  currentCTC: "", expectedCTC: "", relocate: "", skillYears: "", extraFacts: "",
};

const emptyResumes = (): Resume[] => [0, 1, 2].map((i) => ({ name: `Resume ${i + 1}`, text: "" }));

export async function loadSettings(): Promise<Settings> {
  const s = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  const resumes = emptyResumes();
  const stored = Array.isArray(s.resumes) ? (s.resumes as Resume[]) : [];
  stored.slice(0, 3).forEach((r, i) => (resumes[i] = { name: r.name || `Resume ${i + 1}`, text: r.text || "" }));
  // v0.1 kept a single resume in resumeText
  if (typeof s.resumeText === "string" && s.resumeText && !resumes[0].text) resumes[0].text = s.resumeText;
  return {
    apiKey: typeof s.apiKey === "string" ? s.apiKey : "",
    model: typeof s.model === "string" && s.model.trim() ? s.model : DEFAULT_MODEL,
    resumes,
    activeResume: typeof s.activeResume === "number" ? s.activeResume : 0,
    profile: { ...EMPTY_PROFILE, ...((s.profile as Partial<Profile>) ?? {}) },
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set(patch);
}
