import { useEffect, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { Job } from "../shared/job";
import { loadSettings, saveSettings, type Settings } from "../shared/storage";
import type { FillReport } from "../shared/types";
import "../shared/styles.css";

const STALE_MS = 10 * 60 * 1000;
const MAX_CELLS = 60;

type Kind = "ok" | "draft" | "left" | "idle";

function cellsFor(r: FillReport | undefined, stopped: boolean): Kind[] {
  if (!r) return [];
  const counts: [Kind, number][] = [
    ["ok", r.fromProfile],
    ["draft", r.aiDrafts.length],
    [stopped ? "idle" : "left", r.needsYou.length],
  ];
  const total = counts.reduce((a, [, n]) => a + n, 0);
  if (!total) return [];
  const scale = total > MAX_CELLS ? MAX_CELLS / total : 1;
  return counts.flatMap(([k, n]) => Array<Kind>(n ? Math.max(1, Math.round(n * scale)) : 0).fill(k));
}

function Strip({ cells, scanning, fresh }: { cells: Kind[]; scanning: boolean; fresh: boolean }) {
  const list = cells.length ? cells : scanning ? Array<Kind>(24).fill("idle") : [];
  if (!list.length) return null;
  return (
    <div className={`strip${scanning ? " scanning" : ""}${fresh ? " fresh" : ""}`} role="img" aria-label="One square per form field">
      {list.map((k, i) => <i key={i} className={`cell ${k}`} style={{ "--i": i } as CSSProperties} />)}
    </div>
  );
}

const Gear = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

function Popup() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    loadSettings().then(setSettings);
    chrome.storage.local.get("job").then((r) => setJob((r.job as Job) ?? null));
    const onChange = (c: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && c.job) setJob((c.job.newValue as Job) ?? null);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, []);

  useEffect(() => { if (job?.state !== "running") setStopping(false); }, [job?.state]);

  if (!settings) return null;

  const filled = settings.resumes.map((r, i) => ({ ...r, i })).filter((r) => r.text.trim());
  const active = filled.some((r) => r.i === settings.activeResume) ? settings.activeResume : filled[0]?.i ?? 0;
  const running = job?.state === "running" && Date.now() - job.startedAt < STALE_MS;

  const pick = (i: number) => {
    setSettings({ ...settings, activeResume: i });
    void saveSettings({ activeResume: i });
  };

  const fill = async (advance: boolean) => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    setJob({ state: "running", startedAt: Date.now(), page: tab.title, advance, phase: "Starting" });
    chrome.runtime.sendMessage({ type: "fill", tabId: tab.id, resumeIndex: active, advance }).catch(() => {});
  };

  const stop = () => {
    setStopping(true);
    chrome.runtime.sendMessage({ type: "stop" }).catch(() => {});
  };

  const report = job?.report;
  const stopped = job?.state === "stopped";
  const done = job?.state === "done";
  const cells = cellsFor(report, stopped);
  const nFilled = report ? report.fromProfile + report.aiDrafts.length : 0;

  return (
    <div className="pop">
      <div className="bar">
        <div className="brand"><span className="mark"><i /><i /><i /></span>ApplyCraft</div>
        <button className="icon-btn" onClick={() => chrome.runtime.openOptionsPage()} aria-label="Open settings" title="Settings"><Gear /></button>
      </div>

      {filled.length === 0 ? (
        <>
          <p>Add a resume and your details to get started.</p>
          <div className="actions"><button className="btn primary" onClick={() => chrome.runtime.openOptionsPage()}>Open settings</button></div>
        </>
      ) : (
        <>
          <span className="field-label" id="rl">Resume</span>
          <div className="seg" role="radiogroup" aria-labelledby="rl">
            {filled.map((r) => (
              <button key={r.i} role="radio" aria-checked={r.i === active} disabled={running} onClick={() => pick(r.i)} title={r.name}>
                {r.name || `Resume ${r.i + 1}`}
              </button>
            ))}
          </div>

          {running ? (
            <div className="run">
              <div className="phase" role="status" aria-live="polite">
                <span className="pulse" />{stopping ? "Stopping…" : job?.phase ?? "Working"}
              </div>
              <button className="btn stop" onClick={stop} disabled={stopping}>{stopping ? "Stopping…" : "Stop"}</button>
            </div>
          ) : (
            <>
              <div className="actions">
                <button className="btn primary" onClick={() => fill(false)}>Fill this page</button>
                <button className="btn ghost" onClick={() => fill(true)}>Fill and continue</button>
              </div>
              <p className="hint">Continue also clicks Next. It never clicks Submit or Apply, and stops whenever something needs you.</p>
            </>
          )}
        </>
      )}

      {(running || job) && (
        <div className="result">
          {job?.state === "error" && <div className="notice bad">{job.error}</div>}

          {(done || stopped || running) && report && (
            <>
              <div className="headline">
                {stopped ? `Stopped after ${nFilled} field${nFilled === 1 ? "" : "s"}` : `${nFilled} of ${report.fieldCount} fields filled`}
              </div>
              {job?.page && <div className="sub">{job.page}</div>}
            </>
          )}
          {stopped && !report && <div className="headline">Stopped</div>}

          <Strip cells={cells} scanning={running} fresh={done || stopped} />

          {report && (
            <ul className="legend">
              <li><span className="sw" style={{ background: "var(--ok)" }} />Filled from your details<b>{report.fromProfile}</b></li>
              {report.aiDrafts.length > 0 && <li><span className="sw" style={{ background: "var(--draft)" }} />Drafted by AI, review these<b>{report.aiDrafts.length}</b></li>}
              {!stopped && <li><span className="sw" style={{ background: "var(--left)" }} />Left for you<b>{report.needsYou.length}</b></li>}
            </ul>
          )}

          {job?.stopReason && <div className="notice">{job.stopReason}</div>}
          {report?.aiError && <div className="notice bad">AI drafting failed: {report.aiError}</div>}

          {report && report.aiDrafts.length > 0 && (
            <details className="fold" open>
              <summary>Review {report.aiDrafts.length} drafted answer{report.aiDrafts.length === 1 ? "" : "s"}</summary>
              {report.aiDrafts.map((d, i) => (
                <div className="draft-item" key={i}><q>{d.label}</q>{d.answer}</div>
              ))}
            </details>
          )}

          {!stopped && report && report.needsYou.length > 0 && (
            <details className="fold">
              <summary>{report.needsYou.length} left for you</summary>
              <ul>{report.needsYou.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </details>
          )}

          {job?.steps && job.steps.length > 1 && (
            <details className="fold">
              <summary>{job.steps.length} pages handled</summary>
              <ul>
                {job.steps.map((st, i) => (
                  <li key={i}>{st.page}: {st.filled} filled{st.needsYou.length ? `, ${st.needsYou.length} left for you` : ""}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Popup />);
