import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GeminiProvider, listUsableModels } from "../src/llm/gemini";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const answer = (text: string) => json({ candidates: [{ content: { parts: [{ text }] } }] });

const MODEL_LIST = {
  models: [
    { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
    { name: "models/gemini-3-pro-preview", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3-flash-lite", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("model discovery", () => {
  it("lists only text models the key can call, stable Flash first", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(MODEL_LIST)));
    expect(await listUsableModels("k")).toEqual(["gemini-3-flash", "gemini-3-flash-lite", "gemini-3-pro-preview"]);
  });

  it("falls back to discovered models when the configured ones are not found", async () => {
    const used: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes(":generateContent")) {
        used.push(url.split("/models/")[1].split(":")[0]);
        return used.at(-1) === "gemini-3-flash" ? answer('{"ok":true}') : json({}, 404);
      }
      return json(MODEL_LIST);
    }));
    const llm = new GeminiProvider("k", "gemini-2.5-flash, gemini-2.5-flash-lite");
    const out = await llm.completeJson({ system: "s", prompt: "p", schema: z.object({ ok: z.boolean() }) });
    expect(out).toEqual({ ok: true });
    expect(used).toEqual(["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3-flash"]);
  });

  it("reports a clear error when nothing works", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes(":generateContent") ? json({}, 404) : json(MODEL_LIST))));
    const llm = new GeminiProvider("k", "a");
    await expect(llm.completeJson({ system: "s", prompt: "p", schema: z.object({}) })).rejects.toThrow(/All models failed/);
  });
});
