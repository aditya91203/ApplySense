import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fillPage, scanPage, setCancelFlag } from "../src/fill/inject";

beforeEach(() => {
  document.body.innerHTML = `<form>
    <label for="a">Full name</label><input id="a"/>
    <label for="b">Email</label><input id="b"/>
    <label for="c">City</label><input id="c"/>
    <button type="button" id="dd" aria-haspopup="listbox" aria-label="Country Select Required">Select One</button>
    <button type="submit">Submit</button></form>`;
});
afterEach(() => setCancelFlag(false));

const text = (id: string) => (document.getElementById(id) as HTMLInputElement).value;

describe("cancelling inside the page", () => {
  it("fills nothing if Stop was already pressed", async () => {
    const { fields } = scanPage();
    setCancelFlag(true);
    const out = await fillPage(fields.filter((f) => f.kind === "text").map((f) => ({ id: f.id, status: "profile" as const, value: "x" })));
    expect(out).toEqual([]);
    expect([text("a"), text("b"), text("c")]).toEqual(["", "", ""]);
  });

  it("stops between fields and keeps what was already filled", async () => {
    const { fields } = scanPage();
    const texts = fields.filter((f) => f.kind === "text");
    const input = document.getElementById("b")!;
    input.addEventListener("input", () => setCancelFlag(true)); // Stop arrives right after the 2nd field
    const out = await fillPage(texts.map((f, i) => ({ id: f.id, status: "profile" as const, value: `v${i}` })));
    expect(out.map((o) => o.applied)).toEqual([true, true]);
    expect([text("a"), text("b"), text("c")]).toEqual(["v0", "v1", ""]);
  });

  it("interrupts a dropdown that is waiting for its list to open", async () => {
    const dd = scanPage().fields.find((f) => f.kind === "dropdown")!;
    const t0 = Date.now();
    setTimeout(() => setCancelFlag(true), 250);
    const out = await fillPage([{ id: dd.id, status: "profile", value: "India" }]);
    expect(Date.now() - t0).toBeLessThan(1200); // would take 2s+ without the flag
    expect(out[0].applied).toBe(false);
  });

  it("works again once the flag is cleared for the next run", async () => {
    setCancelFlag(true);
    setCancelFlag(false);
    const { fields } = scanPage();
    const a = fields.find((f) => f.label === "Full name")!;
    expect((await fillPage([{ id: a.id, status: "profile", value: "Z" }]))[0].applied).toBe(true);
  });
});
