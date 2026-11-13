export type FieldKind = "text" | "textarea" | "select" | "radio" | "checkbox" | "file" | "dropdown";

export interface ScannedField {
  id: string;
  kind: FieldKind;
  label: string;
  inputType?: string;
  /** Known up front for native selects and radios. Custom dropdowns reveal theirs only when opened. */
  options?: string[];
  required: boolean;
  maxLength?: number;
  /** Already has a value on the page; ApplyCraft leaves it alone. */
  filled: boolean;
}

export interface PageContext {
  title: string;
  heading: string;
  pageText: string;
}

export interface ScanResult {
  fields: ScannedField[];
  context: PageContext;
}

export type FillStatus = "profile" | "ai" | "needs-you";

/**
 * value undefined (or status needs-you) = only highlight the field for the person to complete.
 * For custom dropdowns, value may hold alternatives separated by "||", tried in order.
 * For a checkbox, value "checked" ticks it.
 */
export interface FillInstruction {
  id: string;
  status: FillStatus;
  value?: string;
  note?: string;
}

export interface FillOutcome {
  id: string;
  applied: boolean;
}

export interface FillReport {
  fieldCount: number;
  fromProfile: number;
  aiDrafts: { label: string; answer: string }[];
  needsYou: string[];
  /** Required fields still unanswered: these stop automatic page advancing. */
  blocking: string[];
  aiError?: string;
}

export interface SectionPrep {
  ok: boolean;
  scope?: string;
  note?: string;
}

export interface AdvanceResult {
  clicked: boolean;
  label?: string;
  reason?: string;
}
