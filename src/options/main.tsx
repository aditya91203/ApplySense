import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { listUsableModels } from "../llm/gemini";
import { parseResume } from "../fill/parseResume";
import {
  DEFAULT_MODEL, EMPTY_PROFILE, loadSettings, saveSettings,
  type Profile, type Resume, type Settings,
} from "../shared/storage";
import "../shared/styles.css";

const snapshot = (s: Settings) => JSON.stringify([s.apiKey, s.model, s.resumes, s.profile]);

function Section({ title, why, children }: { title: string; why: ReactNode; children: ReactNode }) {
  return (
    <section className="sec">
      <div><h2>{title}</h2><p className="why">{why}</p></div>
      <div className="stack">{children}</div>
    </section>
  );
}

function ResumeSlot({ index, resume, onChange }: { index: number; resume: Resume; onChange: (r: Resume) => void }) {
  const parsed = useMemo(() => parseResume(resume.text), [resume.text]);
  const found = parsed.experience.length + parsed.education.length;
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async (file?: File) => {
    if (!file) return;
    onChange({ ...resume, text: await file.text(), name: resume.name || file.name.replace(/\.[^.]+$/, "") });
  };

  return (
    <div className="slot">
      <div className="slot-head">
        <input aria-label={`Name of resume ${index + 1}`} value={resume.name} onChange={(e) => onChange({ ...resume, name: e.target.value })} />
        <button className="btn ghost" onClick={() => fileRef.current?.click()}>Load .txt</button>
        <input ref={fileRef} type="file" accept=".txt,.md,text/plain" hidden onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      <textarea
        aria-label={`Text of resume ${index + 1}`}
        value={resume.text}
        placeholder="Paste the resume as plain text"
        onChange={(e) => onChange({ ...resume, text: e.target.value })}
      />
      {resume.text.trim() && (
        <div className={`parsed${found ? "" : " none"}`} role="status">
          <span className="sw" />
          {found
            ? `Read ${parsed.experience.length} job${parsed.experience.length === 1 ? "" : "s"} and ${parsed.education.length} education entr${parsed.education.length === 1 ? "y" : "ies"} from this resume`
            : "Could not find Experience or Education sections. Those fields will be left for you."}
        </div>
      )}
    </div>
  );
}

function Options() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState("");
  const [note, setNote] = useState("");
  const [showKey, setShowKey] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadSettings().then((x) => { setS(x); setSaved(snapshot(x)); }); }, []);
  if (!s) return null;

  const dirty = snapshot(s) !== saved;
  const flash = (m: string) => { setNote(m); setTimeout(() => setNote(""), 3500); };
  const setProfile = (k: keyof Profile, v: string) => setS({ ...s, profile: { ...s.profile, [k]: v } });
  const setResume = (i: number, r: Resume) => setS({ ...s, resumes: s.resumes.map((x, j) => (j === i ? r : x)) });

  const save = async () => {
    const next = { ...s, apiKey: s.apiKey.trim(), model: s.model.trim() || DEFAULT_MODEL };
    await saveSettings({ apiKey: next.apiKey, model: next.model, resumes: next.resumes, profile: next.profile });
    setS(next);
    setSaved(snapshot(next));
    flash("Saved");
  };

  const findModels = async () => {
    if (!s.apiKey.trim()) return flash("Enter your API key first.");
    try {
      const ids = await listUsableModels(s.apiKey.trim());
      if (!ids.length) return flash("This key can call no Gemini text models.");
      setS({ ...s, model: ids.slice(0, 3).join(", ") });
      flash(`Found ${ids.length}. Using the top 3. Save to keep.`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not list models.");
    }
  };

  const importJson = async (file: File | undefined) => {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as Record<string, unknown>;
      const next = { ...s.profile };
      for (const k of Object.keys(EMPTY_PROFILE) as (keyof Profile)[]) {
        if (typeof data[k] === "string") next[k] = data[k] as string;
      }
      setS({ ...s, profile: next });
      flash("Imported. Review the fields, then save.");
    } catch {
      flash("That file is not valid JSON.");
    }
  };

  const text = (k: keyof Profile, label: string, hint?: string) => (
    <div className="f" key={k}>
      <label htmlFor={`p-${k}`}>{label}</label>
      <input id={`p-${k}`} value={s.profile[k]} onChange={(e) => setProfile(k, e.target.value)} />
      {hint && <small>{hint}</small>}
    </div>
  );

  return (
    <div className="page">
      <header className="top">
        <div className="brand"><span className="mark"><i /><i /><i /></span>ApplyCraft</div>
        <div className="spacer" />
        <span className={`state${dirty ? " dirty" : ""}`} role="status" aria-live="polite">{note || (dirty ? "Unsaved changes" : "All changes saved")}</span>
        <button className="btn primary" onClick={save} disabled={!dirty}>Save</button>
      </header>

      <Section title="Resumes" why="Pick one in the popup before you fill. Work Experience and Education are copied from it, word for word.">
        {s.resumes.map((r, i) => <ResumeSlot key={i} index={i} resume={r} onChange={(x) => setResume(i, x)} />)}
      </Section>

      <Section title="Your details" why="Used exactly as written, before anything else. Anything left blank is left for you on the form, never guessed.">
        <div className="row">
          <button className="btn ghost" style={{ height: 36 }} onClick={() => importRef.current?.click()}>Import details from JSON</button>
          <input ref={importRef} type="file" accept="application/json" hidden onChange={(e) => { void importJson(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
        <h3 className="group-title">Contact</h3>
        <div className="grid">
          {text("fullName", "Full name")}{text("email", "Email")}
          {text("phoneCountryCode", "Country phone code", "e.g. India (+91)")}{text("phone", "Phone number", "Without the country code")}
          {text("phoneDeviceType", "Phone device type", "e.g. Mobile")}{text("linkedin", "LinkedIn URL")}
          {text("github", "GitHub URL")}{text("portfolio", "Portfolio or website")}
        </div>
        <h3 className="group-title">Address</h3>
        <div className="grid">
          {text("addressLine1", "Address line 1")}{text("addressLine2", "Address line 2")}
          {text("city", "City")}{text("state", "State")}
          {text("postalCode", "Postal code")}{text("country", "Country")}
        </div>
        <h3 className="group-title">Work</h3>
        <div className="grid">
          {text("currentCompany", "Current company", "Blank = from your resume")}{text("currentTitle", "Current title", "Blank = from your resume")}
          {text("totalExperience", "Total experience", "As you want it entered, e.g. 1.5")}{text("noticePeriod", "Notice period", "e.g. 45")}
          {text("currentCTC", "Current CTC")}{text("expectedCTC", "Expected CTC", "e.g. 1000000 INR")}
        </div>
        <h3 className="group-title">Education</h3>
        <div className="grid">
          {text("school", "College or university", "Blank = from your resume")}{text("degree", "Degree", "Blank = from your resume")}
          {text("fieldOfStudy", "Branch or field", "Blank = from your resume")}{text("cgpa", "CGPA", "Blank = from your resume")}
          {text("graduationYear", "Graduation year", "Blank = from your resume")}
        </div>
        <h3 className="group-title">Eligibility</h3>
        <div className="grid">
          {text("workAuthorized", "Legally eligible to work", "Yes or No")}{text("relocate", "Willing to relocate", "Yes or No")}
          {text("meetsMinimumAge", "Meets minimum working age", "Yes or No")}{text("previouslyEmployed", "Worked there before", "Yes or No")}
          {text("howHeard", "How did you hear about us / Source", "e.g. Other")}
        </div>
      </Section>

      <Section title="Your own answers" why="For questions only you can answer. They override everything else.">
        <div className="f">
          <label htmlFor="custom">Question phrase =&gt; answer</label>
          <textarea id="custom" value={s.profile.customAnswers} placeholder={"principal accountant => No\nsecurity clearance => No"} onChange={(e) => setProfile("customAnswers", e.target.value)} />
          <small>One per line. Matched against the question text on the form.</small>
        </div>
        <div className="f">
          <label htmlFor="skills">Years per skill</label>
          <textarea id="skills" value={s.profile.skillYears} placeholder={"C#: 1.5\n.NET: 1.5\nReact: 1"} onChange={(e) => setProfile("skillYears", e.target.value)} />
          <small>One per line. A skill not listed is left for you.</small>
        </div>
      </Section>

      <Section title="AI drafting" why="Optional. Everything above works with no key and sends nothing anywhere. A key only adds drafted answers to open questions such as “Why do you want this role?”.">
        <div className="f">
          <label htmlFor="key">Gemini API key</label>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input id="key" type={showKey ? "text" : "password"} value={s.apiKey} autoComplete="off" onChange={(e) => setS({ ...s, apiKey: e.target.value })} />
            <button className="btn ghost" onClick={() => setShowKey(!showKey)} style={{ height: 38 }}>{showKey ? "Hide" : "Show"}</button>
          </div>
          <small>From aistudio.google.com. Stored only in this browser. Leave blank to stay fully offline.</small>
        </div>
        <div className="f">
          <label htmlFor="model">Models, tried in order</label>
          <input id="model" value={s.model} onChange={(e) => setS({ ...s, model: e.target.value })} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn ghost" onClick={findModels} style={{ height: 36 }}>Find models my key can use</button>
          </div>
        </div>
        <p className="muted">
          With a key, your resume text, the form questions and the page text are sent to Google when you fill. On the free tier Google may use that to improve its products. Your email, phone, address and salary are never sent.
        </p>
      </Section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Options />);
