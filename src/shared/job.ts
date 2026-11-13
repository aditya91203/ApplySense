import type { FillReport } from "./types";

export interface StepSummary {
  page: string;
  filled: number;
  drafts: number;
  needsYou: string[];
  blocking: string[];
}

export interface Job {
  state: "running" | "done" | "error" | "stopped";
  startedAt: number;
  /** What the run is doing right now, e.g. "Filling Work Experience 2 of 3". */
  phase?: string;
  page?: string;
  advance?: boolean;
  /** Report for the last page handled. */
  report?: FillReport;
  steps?: StepSummary[];
  /** Why automatic page advancing stopped. */
  stopReason?: string;
  error?: string;
}
