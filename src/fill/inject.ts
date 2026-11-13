import type {
  AdvanceResult, FillInstruction, FillOutcome, ScanResult, ScannedField, SectionPrep,
} from "../shared/types";

/*
 * These functions are serialized into the web page by chrome.scripting.executeScript({ func }).
 * Each must therefore be fully self-contained: no references to module-level helpers or imports
 * (type-only imports are erased and are fine).
 *
 * SAFETY: nothing here submits, sends or applies. The only things ever clicked are:
 *   - radio options and custom dropdown triggers/options (fillPage)
 *   - a checkbox, only when the planner explicitly asks (e.g. "I currently work here")
 *   - an "Add" button of a Work Experience / Education section (prepareSection)
 *   - a Next / Continue / Save and Continue button, never one whose label looks like
 *     Submit / Apply / Finish / Send / Confirm (advancePage)
 * tests/ run all of this against pages with decoy Submit and Apply buttons.
 */

/** Page-side switch the Stop button flips; fillPage and prepareSection check it between steps. */
export function setCancelFlag(on: boolean): void {
  (window as unknown as { __applycraftCancel?: boolean }).__applycraftCancel = on;
}

export function scanPage(scope?: string): ScanResult {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const emptyCtx = { title: document.title, heading: "", pageText: "" };

  const root: ParentNode = scope ? document.querySelector(scope) ?? document : document;
  if (scope && root === document) return { fields: [], context: emptyCtx };

  const textOf = (el: Element | null): string => {
    if (!el) return "";
    const c = el.cloneNode(true) as Element;
    c.querySelectorAll("input,select,textarea,button,script,style").forEach((n) => n.remove());
    return squash(c.textContent);
  };

  const hidden = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if ((n as HTMLElement).hidden || n.getAttribute("aria-hidden") === "true") return true;
      const st = getComputedStyle(n);
      if (st.display === "none" || st.visibility === "hidden") return true;
    }
    return false;
  };

  const byIds = (ids: string | null) =>
    squash((ids ?? "").split(/\s+/).filter(Boolean).map((i) => textOf(document.getElementById(i))).join(" "));

  const humanize = (s: string) => squash(s.replace(/[_\-[\]]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"));

  // Nearest text that precedes a control (or group) without containing any control.
  const labelBefore = (start: Element): string => {
    let node: Element | null = start;
    for (let depth = 0; depth < 4 && node; depth++) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      const parts: string[] = [];
      for (const child of Array.from(parent.children)) {
        if (child === node || child.contains(node)) break;
        if (child.querySelector("input,select,textarea")) continue;
        const t = textOf(child);
        if (t && t.length < 250) parts.push(t);
      }
      if (parts.length) return parts[parts.length - 1];
      node = parent;
    }
    return "";
  };

  // ---- Google Forms / Microsoft Forms --------------------------------------
  // Both put a question title in a heading inside a question container. Their inputs'
  // aria-labelledby often points at the whole container, so the title is read directly.
  const QUESTION = '[data-automation-id="questionItem"],[id^="QuestionId_"],[role="listitem"]';
  const formsMode =
    (location.hostname === "docs.google.com" && location.pathname.includes("/forms/")) ||
    location.hostname === "forms.gle" ||
    /(^|\.)forms\.(office|microsoft)\.com$/.test(location.hostname) ||
    !!document.querySelector('form[action*="docs.google.com/forms"],[data-automation-id="questionItem"],[id^="QuestionId_"]');

  const questionTitle = (el: Element): string => {
    const q = el.closest(QUESTION);
    if (!q) return "";
    const t = q.querySelector('[data-automation-id="questionTitle"]') ?? q.querySelector('[role="heading"]');
    if (!t) return "";
    const c = t.cloneNode(true) as Element;
    c.querySelectorAll('[data-automation-id="questionOrdinal"],[aria-hidden="true"],input,select,textarea,button,script,style')
      .forEach((n) => n.remove());
    return squash(c.textContent);
  };

  const questionRequired = (el: Element): boolean =>
    !!el.closest(QUESTION)?.querySelector('[aria-label="Required question"],[data-automation-id="requiredStar"]');

  const rawLabel = (el: HTMLElement): string => {
    if (formsMode) {
      const q = questionTitle(el);
      if (q) return q;
    }
    const lb = byIds(el.getAttribute("aria-labelledby"));
    if (lb) return lb;
    const ls = squash(Array.from((el as HTMLInputElement).labels ?? []).map(textOf).join(" "));
    if (ls) return ls;
    const al = squash(el.getAttribute("aria-label"));
    if (al) return al;
    const before = labelBefore(el);
    if (before) return before;
    const ph = squash(el.getAttribute("placeholder"));
    if (ph) return ph;
    return humanize(el.getAttribute("name") || el.id || "");
  };

  // Month / Year style inputs only make sense with their group ("From", "To").
  const groupCtx = (el: HTMLElement): string => {
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend && textOf(legend)) return textOf(legend);
    const g = el.closest('[role="group"],[role="radiogroup"]');
    const gl = g ? byIds(g.getAttribute("aria-labelledby")) || squash(g.getAttribute("aria-label")) : "";
    if (gl) return gl;
    return labelBefore(el.parentElement ?? el);
  };

  const describe = (el: HTMLElement): { label: string; starred: boolean } => {
    const raw = rawLabel(el);
    const aria = squash(el.getAttribute("aria-label"));
    const starred =
      /\*\s*$/.test(raw) || /\brequired\b/i.test(aria) || /\brequired\b/i.test(raw) ||
      (formsMode && questionRequired(el));
    let label = raw
      .replace(/\s*\*+\s*$/, "")
      .replace(/\s+select(?:\s+one)?(?:\s+required)?$/i, "")
      .replace(/\s+required$/i, "")
      .trim();
    if (/^(month|year|day|mm|yyyy|dd)$/i.test(label)) {
      const g = groupCtx(el).replace(/\s*\*+\s*$/, "");
      if (g) label = `${g} ${label}`;
    }
    return { label, starred };
  };

  const groupLabelRaw = (radios: HTMLInputElement[]): string => {
    const first = radios[0];
    if (formsMode) {
      const q = questionTitle(first);
      if (q) return q;
    }
    const legend = first.closest("fieldset")?.querySelector("legend");
    if (legend && textOf(legend)) return textOf(legend);
    const rg = first.closest('[role="radiogroup"],[role="group"]');
    const l = rg ? byIds(rg.getAttribute("aria-labelledby")) || squash(rg.getAttribute("aria-label")) : "";
    if (l) return l;
    return labelBefore(first) || humanize(first.name);
  };

  const optionLabel = (r: HTMLInputElement): string =>
    squash(Array.from(r.labels ?? []).map(textOf).join(" ")) ||
    squash(r.getAttribute("aria-label")) ||
    textOf(r.nextElementSibling) ||
    squash(r.nextSibling?.textContent) ||
    squash(r.value);

  // Clear tags from any earlier scan of this page (multi-step forms are scanned repeatedly).
  document.querySelectorAll("[data-ac-id],[data-ac-group],[data-ac-opt]").forEach((e) => {
    e.removeAttribute("data-ac-id");
    e.removeAttribute("data-ac-group");
    e.removeAttribute("data-ac-opt");
  });

  const tok = Math.random().toString(36).slice(2, 6);
  let n = 0;
  const nextId = () => `ac-${tok}-${++n}`;
  const placeholderRx = /^(select( one)?|choose|please select|--)/i;
  const SKIP = new Set(["hidden", "submit", "button", "image", "reset", "password", "range", "color"]);
  const CUSTOM =
    'button[aria-haspopup="listbox"],[role="combobox"],[role="button"][aria-haspopup="listbox"],[role="listbox"][aria-expanded]';
  const SELECTED = '[data-automation-id="selectedItem"],[data-automation-id="selectedItemList"] li';
  const fields: ScannedField[] = [];
  const radioGroups = new Map<string, HTMLInputElement[]>();
  let soloRadio = 0;
  // Entries already filled by prepareSection are tagged; the page-wide scan must not touch them.
  const inFilledBlock = (el: Element) => !scope && !!el.closest("[data-ac-block]");

  const candidates = Array.from(
    new Set([
      ...Array.from(root.querySelectorAll<HTMLElement>("input,textarea,select")),
      ...Array.from(root.querySelectorAll<HTMLElement>(CUSTOM)),
    ]),
  ).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  for (const el of candidates) {
    if (hidden(el) || (el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
    if (inFilledBlock(el)) continue;

    const isSelect = el instanceof HTMLSelectElement;
    const isArea = el instanceof HTMLTextAreaElement;
    const type = el instanceof HTMLInputElement ? el.type.toLowerCase() : "";
    const custom =
      !isSelect && !isArea &&
      (el.matches(CUSTOM) ||
        (el instanceof HTMLInputElement && !!el.closest('[data-automation-id="multiSelectContainer"]')));

    if (custom) {
      // A wrapper that contains a real input: the inner input is the control.
      if (!(el instanceof HTMLInputElement) && el.querySelector('input:not([type="hidden"])')) continue;
      const id = nextId();
      el.setAttribute("data-ac-id", id);
      const { label, starred } = describe(el);
      let filled: boolean;
      if (el.getAttribute("role") === "listbox") {
        const sel = el.querySelector('[role="option"][aria-selected="true"]');
        filled = !!sel && (sel.getAttribute("data-value") ?? "x") !== "" && !placeholderRx.test(squash(sel.textContent));
      } else if (el instanceof HTMLInputElement) {
        filled = el.value.trim() !== "" || !!el.closest('[data-automation-id="multiSelectContainer"]')?.querySelector(SELECTED);
      } else {
        filled = squash(el.textContent) !== "" && !placeholderRx.test(squash(el.textContent));
      }
      fields.push({ id, kind: "dropdown", label, required: starred || el.getAttribute("aria-required") === "true", filled });
      continue;
    }

    if ((el as HTMLInputElement).readOnly) continue;
    if (SKIP.has(type)) continue;

    if (type === "radio") {
      const r = el as HTMLInputElement;
      const key = r.name || `__solo-${soloRadio++}`;
      radioGroups.set(key, [...(radioGroups.get(key) ?? []), r]);
      continue;
    }

    // The "Other:" text box beside a radio/checkbox question belongs to that option, not a question.
    if (el instanceof HTMLInputElement) {
      const al = squash(el.getAttribute("aria-label"));
      const da = el.getAttribute("data-automation-id") ?? "";
      if ((/^other\b/i.test(al) || /other/i.test(da)) &&
          el.closest(QUESTION)?.querySelector('[role="radio"],[role="checkbox"],input[type="radio"],input[type="checkbox"]')) continue;
    }

    const id = nextId();
    el.setAttribute("data-ac-id", id);
    const { label, starred } = describe(el);
    const required = starred || (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true";

    if (el instanceof HTMLSelectElement) {
      const options = Array.from(el.options)
        .filter((o) => o.value !== "" && !placeholderRx.test(squash(o.text)))
        .map((o) => squash(o.text));
      const chosen = el.selectedOptions[0];
      fields.push({
        id, kind: "select", label, options, required,
        filled: el.value !== "" && !!chosen && !placeholderRx.test(squash(chosen.text)),
      });
    } else if (el instanceof HTMLTextAreaElement) {
      fields.push({
        id, kind: "textarea", label, required,
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
        filled: el.value.trim() !== "",
      });
    } else if (el instanceof HTMLInputElement && type === "checkbox") {
      fields.push({ id, kind: "checkbox", label, required, filled: el.checked });
    } else if (el instanceof HTMLInputElement && type === "file") {
      fields.push({ id, kind: "file", label, required, filled: (el.files?.length ?? 0) > 0 });
    } else if (el instanceof HTMLInputElement) {
      fields.push({
        id, kind: "text", label, inputType: type || "text", required,
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
        filled: el.value.trim() !== "",
      });
    }
  }

  for (const radios of radioGroups.values()) {
    if (inFilledBlock(radios[0])) continue;
    const id = nextId();
    const options = radios.map(optionLabel);
    radios.forEach((r, i) => {
      r.setAttribute("data-ac-group", id);
      r.setAttribute("data-ac-opt", options[i]);
    });
    const raw = groupLabelRaw(radios);
    fields.push({
      id, kind: "radio", label: raw.replace(/\s*\*+\s*$/, "").trim(), options,
      required: /\*\s*$/.test(raw) || radios.some((r) => r.required) || (formsMode && questionRequired(radios[0])),
      filled: radios.some((r) => r.checked),
    });
  }

  // Custom ARIA radios (Google Forms): <div role="radio" aria-checked data-value>
  const ariaRadios = new Map<Element, HTMLElement[]>();
  for (const r of Array.from(root.querySelectorAll<HTMLElement>('[role="radio"]'))) {
    if (r instanceof HTMLInputElement || hidden(r) || inFilledBlock(r)) continue;
    const key = r.closest('[role="radiogroup"]') ?? r.closest(QUESTION) ?? r.parentElement ?? r;
    ariaRadios.set(key, [...(ariaRadios.get(key) ?? []), r]);
  }
  for (const [group, items] of ariaRadios) {
    const id = nextId();
    const options = items.map((r) => squash(r.getAttribute("aria-label")) || squash(r.getAttribute("data-value")) || textOf(r));
    items.forEach((r, i) => {
      r.setAttribute("data-ac-group", id);
      r.setAttribute("data-ac-opt", options[i]);
    });
    const raw =
      (formsMode ? questionTitle(items[0]) : "") ||
      byIds(group.getAttribute("aria-labelledby")) ||
      squash(group.getAttribute("aria-label")) ||
      labelBefore(group);
    fields.push({
      id, kind: "radio", label: raw.replace(/\s*\*+\s*$/, "").trim(), options,
      required: /\*\s*$/.test(raw) || group.getAttribute("aria-required") === "true" || questionRequired(items[0]),
      filled: items.some((r) => r.getAttribute("aria-checked") === "true"),
    });
  }

  // Custom ARIA checkboxes: one field per question; the planner never ticks these for you.
  const ariaChecks = new Map<Element, HTMLElement[]>();
  for (const c of Array.from(root.querySelectorAll<HTMLElement>('[role="checkbox"]'))) {
    if (c instanceof HTMLInputElement || hidden(c) || inFilledBlock(c)) continue;
    const key = c.closest(QUESTION) ?? c;
    ariaChecks.set(key, [...(ariaChecks.get(key) ?? []), c]);
  }
  for (const [key, items] of ariaChecks) {
    const id = nextId();
    key.setAttribute("data-ac-id", id);
    const own = squash(items[0].getAttribute("aria-label")) || textOf(items[0]);
    const label = (key === items[0] ? own : questionTitle(items[0])) || own;
    fields.push({
      id, kind: "checkbox", label: label.replace(/\s*\*+\s*$/, "").trim(),
      options: items.map((c) => squash(c.getAttribute("aria-label")) || squash(c.getAttribute("data-answer-value")) || textOf(c)),
      required: questionRequired(items[0]),
      filled: items.some((c) => c.getAttribute("aria-checked") === "true"),
    });
  }

  const heading = squash(document.querySelector("h1")?.textContent) || squash(document.querySelector("h2")?.textContent);
  const body = document.body ? (document.body as HTMLElement).innerText ?? document.body.textContent ?? "" : "";
  return { fields, context: { title: document.title, heading, pageText: squash(body).slice(0, 6000) } };
}

export async function fillPage(instructions: FillInstruction[]): Promise<FillOutcome[]> {
  const COLOR = { profile: "#2e9e5b", ai: "#2f6fdb", "needs-you": "#e08a00" } as const;
  const TITLE = {
    profile: "ApplyCraft filled this from your details",
    ai: "ApplyCraft drafted this: review it before you continue",
    "needs-you": "ApplyCraft left this for you to complete",
  } as const;
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const norm = (s: string) => squash(s).toLowerCase();
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const cancelled = () => (window as unknown as { __applycraftCancel?: boolean }).__applycraftCancel === true;
  const placeholderRx = /^(select( one)?|choose|please select|--)/i;

  const hidden = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if ((n as HTMLElement).hidden || n.getAttribute("aria-hidden") === "true") return true;
      const st = getComputedStyle(n);
      if (st.display === "none" || st.visibility === "hidden") return true;
    }
    return false;
  };

  const press = (el: Element) => {
    for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    }
  };

  const mark = (el: HTMLElement, status: FillInstruction["status"], note?: string) => {
    el.style.outline = `2px solid ${COLOR[status]}`;
    el.style.outlineOffset = "2px";
    el.title = status === "needs-you" && note ? `${TITLE[status]} (${note})` : TITLE[status];
  };

  // Native setter + events so React/Angular-controlled inputs register the change.
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
      HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  };

  // ---- custom dropdowns -------------------------------------------------
  const tokens = (s: string) => norm(s).replace(/[^\p{L}\p{N}+]+/gu, " ").trim().split(" ").filter(Boolean);
  const score = (optText: string, wanted: string): number => {
    const o = tokens(optText), w = tokens(wanted);
    if (!o.length || !w.length) return 0;
    if (o.join(" ") === w.join(" ")) return 100;
    if (w.every((t) => o.includes(t))) return 85 - (o.length - w.length);
    if (o.every((t) => w.includes(t))) return 70 - (w.length - o.length);
    const inter = w.filter((t) => o.includes(t)).length;
    return Math.round((60 * inter) / new Set([...o, ...w]).size);
  };

  const optionEls = (trigger: HTMLElement): HTMLElement[] => {
    if (trigger.getAttribute("role") === "listbox") {
      // Google Forms keeps the options inside the listbox itself; value "" is the placeholder row.
      return Array.from(trigger.querySelectorAll<HTMLElement>('[role="option"]'))
        .filter((o) => (o.getAttribute("data-value") ?? "x") !== "" && !hidden(o) && squash(o.textContent) !== "");
    }
    const SEL = '[role="option"],[data-automation-id="promptOption"],[role="menuitem"]';
    const ctl = trigger.getAttribute("aria-controls") || trigger.getAttribute("aria-owns");
    const scoped = ctl ? document.getElementById(ctl) : null;
    let found = scoped ? Array.from(scoped.querySelectorAll<HTMLElement>(SEL)) : [];
    if (!found.length) found = Array.from(document.querySelectorAll<HTMLElement>(SEL));
    return found.filter((o) => !hidden(o) && squash(o.textContent) !== "");
  };

  const closeList = (el: HTMLElement) => {
    const esc = () => new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    el.dispatchEvent(esc());
    document.dispatchEvent(esc());
  };

  const tryOne = async (el: HTMLElement, wanted: string): Promise<boolean> => {
    const isInput = el instanceof HTMLInputElement;
    const isListbox = el.getAttribute("role") === "listbox";
    if (isInput) {
      el.focus();
      press(el);
      setValue(el, wanted);
    } else {
      press(el);
    }
    let opts: HTMLElement[] = [];
    for (let i = 0; i < 20 && !opts.length; i++) {
      if (cancelled()) { closeList(el); return false; }
      await wait(100);
      opts = optionEls(el);
    }
    if (isInput && opts.length) {
      await wait(250); // let search results settle
      opts = optionEls(el);
    }
    let best: HTMLElement | null = null;
    let bestScore = 0;
    let tie = false;
    for (const o of opts) {
      const sc = score(o.textContent ?? "", wanted);
      if (sc > bestScore) { best = o; bestScore = sc; tie = false; }
      else if (sc === bestScore && sc > 0 && best && norm(o.textContent ?? "") !== norm(best.textContent ?? "")) tie = true;
    }
    if (!best || bestScore < 60 || tie || cancelled()) {
      if (isInput) setValue(el, "");
      closeList(el);
      return false;
    }
    press(best);
    await wait(250);
    if (isListbox) {
      const sel = el.querySelector('[role="option"][aria-selected="true"]');
      return !!sel && (sel.getAttribute("data-value") ?? "x") !== "" && score(sel.textContent ?? "", wanted) >= 60;
    }
    if (el instanceof HTMLInputElement) {
      return (
        el.value.trim() !== "" ||
        !!el.closest('[data-automation-id="multiSelectContainer"]')?.querySelector('[data-automation-id="selectedItem"],[data-automation-id="selectedItemList"] li') ||
        optionEls(el).length === 0
      );
    }
    const text = squash(el.textContent);
    return text !== "" && !placeholderRx.test(text);
  };

  const pickDropdown = async (el: HTMLElement, wanted: string): Promise<boolean> => {
    for (const w of wanted.split("||").map((x) => x.trim()).filter(Boolean)) {
      if (cancelled()) return false;
      if (await tryOne(el, w)) return true;
    }
    return false;
  };

  const isChecked = (r: HTMLElement) =>
    r instanceof HTMLInputElement ? r.checked : r.getAttribute("aria-checked") === "true";

  // ---- main loop --------------------------------------------------------
  const outcomes: FillOutcome[] = [];
  for (const ins of instructions) {
    if (cancelled()) break;
    const radios = Array.from(document.querySelectorAll<HTMLElement>(`[data-ac-group="${ins.id}"]`));
    const el = document.querySelector<HTMLElement>(`[data-ac-id="${ins.id}"]`);
    let applied = false;

    if (ins.status !== "needs-you" && ins.value !== undefined) {
      const wanted = norm(ins.value);
      if (radios.length) {
        const pick = radios.find((r) => norm(r.getAttribute("data-ac-opt") ?? "") === wanted);
        if (pick) {
          if (pick instanceof HTMLInputElement) {
            pick.click(); // selects the option
          } else {
            press(pick); // role="radio" element (Google Forms)
            await wait(150);
          }
          applied = isChecked(pick);
        }
      } else if (el instanceof HTMLSelectElement) {
        const opt = Array.from(el.options).find((o) => norm(o.text) === wanted);
        if (opt) {
          setValue(el, opt.value);
          applied = el.value === opt.value;
        }
      } else if (el instanceof HTMLInputElement && el.type === "checkbox") {
        if (wanted === "checked") {
          if (!el.checked) el.click();
          applied = el.checked;
        }
      } else if (el && (el.matches('button,[role="combobox"],[role="button"],[role="listbox"]') || el.closest('[data-automation-id="multiSelectContainer"]'))) {
        applied = await pickDropdown(el, ins.value);
      } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        setValue(el, ins.value);
        applied = el.value.trim() !== "";
      }
    }

    const status = applied ? ins.status : "needs-you";
    const markTarget = radios.length
      ? radios[0] instanceof HTMLInputElement ? radios[0].closest("fieldset") ?? radios[0].parentElement : radios[0].closest('[role="radiogroup"]') ?? radios[0].parentElement
      : el;
    if (markTarget) mark(markTarget as HTMLElement, status, ins.note);
    outcomes.push({ id: ins.id, applied });
  }
  return outcomes;
}

/**
 * Finds (or, if missing, creates with the section's own Add button) the Nth Work Experience or
 * Education entry on the page and tags it so it can be scanned on its own.
 * With dryRun it only reports whether the section exists.
 */
export async function prepareSection(kind: "experience" | "education", index: number, dryRun = false): Promise<SectionPrep> {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const cancelled = () => (window as unknown as { __applycraftCancel?: boolean }).__applycraftCancel === true;
  const hidden = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if ((n as HTMLElement).hidden || n.getAttribute("aria-hidden") === "true") return true;
      const st = getComputedStyle(n);
      if (st.display === "none" || st.visibility === "hidden") return true;
    }
    return false;
  };
  const press = (el: Element) => {
    for (const t of ["pointerdown", "mousedown", "mouseup", "click"]) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    }
  };

  const isExp = kind === "experience";
  const WORKDAY_BLOCK = isExp ? /^workExperience-\d+$/ : /^education-\d+$/;
  const KIND_WORDS = isExp ? /work experience|employment|professional experience|job/i : /education|academic|qualification|school|degree/i;
  const OTHER_WORDS = isExp ? /education|school|degree/i : /work experience|employment|job/i;
  const NUMBERED = isExp
    ? /^(work experience|employment( history)?|professional experience)\s*#?\s*\d+$/i
    : /^(education|academic background|qualifications?)\s*#?\s*\d+$/i;
  const HS = 'h1,h2,h3,h4,h5,h6,[role="heading"],legend';
  const FIELDS = "input,textarea,select,[role=combobox],button[aria-haspopup]";

  const getBlocks = (): HTMLElement[] => {
    const wd = Array.from(document.querySelectorAll<HTMLElement>("[data-automation-id]"))
      .filter((e) => WORKDAY_BLOCK.test(e.getAttribute("data-automation-id") ?? "") && !hidden(e));
    if (wd.length) return wd;
    const heads = Array.from(document.querySelectorAll(HS)).filter((h) => NUMBERED.test(squash(h.textContent)) && !hidden(h));
    const out: HTMLElement[] = [];
    for (const h of heads) {
      for (let a = h.parentElement; a; a = a.parentElement) {
        if (heads.some((o) => o !== h && a.contains(o))) break;
        if (a.querySelector(FIELDS)) { out.push(a); break; }
      }
    }
    return out;
  };

  const btnLabel = (b: Element) => squash(b.getAttribute("aria-label") || b.textContent);
  const nearestHeading = (b: Element): string => {
    for (let a: Element | null = b.parentElement, d = 0; a && d < 8; a = a.parentElement, d++) {
      const hs = Array.from(a.querySelectorAll(HS)).filter((h) => h.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (hs.length) return squash(hs[hs.length - 1].textContent);
    }
    return "";
  };
  const findAdd = (): HTMLElement | null => {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button,[role="button"]')).filter((b) => {
      const l = btnLabel(b);
      return !hidden(b) && /^add\b/i.test(l) && !/language|certification|website|skill|attachment|file|resume|url/i.test(l);
    });
    return (
      buttons.find((b) => {
        const l = btnLabel(b);
        if (KIND_WORDS.test(l)) return true;
        if (OTHER_WORDS.test(l)) return false;
        return KIND_WORDS.test(nearestHeading(b)) && !OTHER_WORDS.test(nearestHeading(b));
      }) ?? null
    );
  };

  let blocks = getBlocks();
  if (dryRun) return { ok: blocks.length > 0 || !!findAdd() };

  if (blocks.length <= index) {
    const add = findAdd();
    if (!add) return { ok: false, note: blocks.length ? "no Add button for another entry" : "section not on this page" };
    press(add);
    for (let i = 0; i < 30 && blocks.length <= index; i++) {
      if (cancelled()) return { ok: false, note: "stopped" };
      await wait(100);
      blocks = getBlocks();
    }
    if (blocks.length <= index) return { ok: false, note: "the new entry did not appear" };
  }
  // Tag every entry on the page so the page-wide scan leaves all of them alone.
  document.querySelectorAll(`[data-ac-block^="${kind}-"]`).forEach((e) => e.removeAttribute("data-ac-block"));
  blocks.forEach((b, i) => b.setAttribute("data-ac-block", `${kind}-${i}`));
  return { ok: true, scope: `[data-ac-block="${kind}-${index}"]` };
}

/**
 * Clicks the page's Next / Continue button. Refuses anything that looks like the final
 * step (Submit, Apply, Finish, Send, Confirm...).
 */
export function advancePage(): AdvanceResult {
  const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const hidden = (el: Element): boolean => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      if ((n as HTMLElement).hidden || n.getAttribute("aria-hidden") === "true") return true;
      const st = getComputedStyle(n);
      if (st.display === "none" || st.visibility === "hidden") return true;
    }
    return false;
  };
  const ALLOWED = /^(save (and|&) (continue|next)|next( step| page)?|continue( to next step)?)$/;
  const FORBIDDEN = /submit|apply|finish|send|confirm|complete|done|place order|pay/;

  const labelled = Array.from(
    document.querySelectorAll<HTMLElement>('button,[role="button"],input[type="submit"],input[type="button"],a[role="button"]'),
  )
    .filter((b) => !hidden(b) && !(b as HTMLButtonElement).disabled && b.getAttribute("aria-disabled") !== "true")
    .map((b) => ({
      b,
      l: squash(b.getAttribute("aria-label") || (b as HTMLInputElement).value || b.textContent).toLowerCase(),
      auto: (b.getAttribute("data-automation-id") ?? "").toLowerCase(),
    }));

  const next = labelled.find((x) => ALLOWED.test(x.l) && !FORBIDDEN.test(x.l) && !/submit/.test(x.auto));
  if (next) {
    next.b.click();
    return { clicked: true, label: next.l };
  }
  const end = labelled.find((x) => /submit|apply|finish/.test(x.l) || /submit/.test(x.auto));
  return end
    ? { clicked: false, reason: `Only "${end.l || "Submit"}" is left. That is the end: review and submit it yourself.` }
    : { clicked: false, reason: "No Next or Continue button found on this page." };
}

/** A cheap fingerprint of the current step, to tell whether clicking Next moved the form on. */
export function pageSignature(): string {
  const heads = Array.from(document.querySelectorAll('h1,h2,[role="heading"]'))
    .slice(0, 3)
    .map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim())
    .join("|");
  const controls = document.querySelectorAll("input,select,textarea,button[aria-haspopup],[role=radio],[role=checkbox],[role=listbox]").length;
  const first = document.querySelector('input:not([type="hidden"]),textarea')?.getAttribute("name") ?? "";
  const q = (document.querySelector('[role="listitem"],[data-automation-id="questionItem"]')?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `${location.href}#${heads}#${controls}#${first}#${q}`;
}
