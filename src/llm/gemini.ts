import type { CompleteJsonOptions, LlmProvider } from "./provider";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const RETRYABLE = new Set([429, 500, 503]);

const abortError = () => new DOMException("Aborted", "AbortError");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });

const NOT_TEXT_MODELS = /embed|tts|image|imagen|veo|live|audio|robotics|computer-use|aqa|gemma|learnlm|native/i;

/**
 * Asks Google which models this key can actually call, so nobody has to guess model IDs.
 * Ordered stable Flash first, then Flash-Lite, then Pro, with preview/experimental last.
 */
export async function listUsableModels(apiKey: string): Promise<string[]> {
  const res = await fetch(`${BASE}?pageSize=200`, { headers: { "x-goog-api-key": apiKey } });
  if (!res.ok) throw new Error(`Could not list models (HTTP ${res.status}). Check the API key.`);
  const data = (await res.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
  const ids = (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => String(m.name ?? "").replace(/^models\//, ""))
    .filter((id) => /gemini/i.test(id) && !NOT_TEXT_MODELS.test(id));
  const rank = (id: string) =>
    (/preview|exp/i.test(id) ? 10 : 0) + (/flash/i.test(id) ? (/lite/i.test(id) ? 1 : 0) : 5);
  return [...new Set(ids)].sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
}

/**
 * Optional. Tries each configured model in order, retrying overloads with jittered backoff.
 * If every one fails (typically "not found" for the key), it discovers the models the key
 * can really use and tries those instead. The signal cancels everything, including waits.
 */
export class GeminiProvider implements LlmProvider {
  private models: string[];

  constructor(private apiKey: string, models: string | string[], private signal?: AbortSignal) {
    this.models = (Array.isArray(models) ? models : models.split(","))
      .map((m) => m.trim())
      .filter(Boolean);
  }

  private async tryModels<T>(
    models: string[],
    body: string,
    parse: (text: string) => T,
    notes: string[],
  ): Promise<T | undefined> {
    for (const model of models) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1) + Math.random() * 500, this.signal);
        const res = await fetch(`${BASE}/${encodeURIComponent(model)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
          body,
          signal: this.signal,
        });
        if (res.status === 404) { notes.push(`${model}: not found`); break; }
        if (RETRYABLE.has(res.status)) { notes.push(`${model}: HTTP ${res.status}`); continue; }
        if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`);
        try {
          const data = await res.json();
          const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) throw new Error("empty response");
          return parse(text);
        } catch (e) {
          if (this.signal?.aborted) throw abortError();
          notes.push(`${model}: bad response (${e instanceof Error ? e.message.slice(0, 80) : "parse error"})`);
        }
      }
    }
    return undefined;
  }

  async completeJson<T>({ system, prompt, schema }: CompleteJsonOptions<T>): Promise<T> {
    const body = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    });
    const parse = (text: string) => schema.parse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim()));
    const notes: string[] = [];

    const first = await this.tryModels(this.models, body, parse, notes);
    if (first !== undefined) return first;

    // Configured models all failed: use whatever this key can actually call.
    const discovered = (await listUsableModels(this.apiKey)).filter((m) => !this.models.includes(m)).slice(0, 4);
    const second = await this.tryModels(discovered, body, parse, notes);
    if (second !== undefined) return second;

    throw new Error(`All models failed. ${notes.slice(-5).join("; ")}.`);
  }
}
