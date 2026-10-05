import { z } from "zod";
import { analyze, type Analysis } from "./analyze.ts";
import type { Usage } from "./backends/types.ts";
import { PipelineError } from "./claude.ts";
import { config } from "./config.ts";
import { llm } from "./llm.ts";
import {
  FIDELITY_SYSTEM,
  fidelityPrompt,
  firstPassPrompt,
  REWRITE_SYSTEM,
  revisionPrompt,
  type RewriteOptions,
} from "./prompts.ts";

export interface HumanizeOptions extends RewriteOptions {
  targetScore: number; // stop once the local score is at or below this (0-100)
  maxPasses: number;
  judge: boolean;
}

const FidelitySchema = z.object({
  summary: z.string().describe("One sentence: is the meaning intact?"),
  issues: z.array(
    z.object({
      kind: z.enum(["dropped", "added", "changed", "voice"]),
      original: z.string().describe("The original wording (short excerpt)"),
      edited: z.string().describe("The edited wording, or empty if dropped"),
      note: z.string().describe("What changed, in under 20 words"),
    }),
  ),
});
export type Fidelity = z.infer<typeof FidelitySchema>;

export type HumanizeEvent =
  | { type: "stage"; stage: "analyzing" | "rewriting" | "scoring" | "checking"; pass?: number; message: string }
  | { type: "before"; analysis: Analysis }
  | { type: "delta"; pass: number; text: string }
  | { type: "draft"; pass: number; text: string; analysis: Analysis; best: boolean }
  | { type: "done"; text: string; bestPass: number; before: Analysis; after: Analysis; fidelity: Fidelity | null; fidelityError?: string; usage: Usage }
  | { type: "error"; message: string };

const OPEN = "<rewrite>";
const CLOSE = "</rewrite>";

// Pulls the text between <rewrite> tags out of a token stream, emitting it as it
// arrives while holding back anything that might be the start of the closing tag.
class RewriteExtractor {
  private buf = "";
  private state: "before" | "inside" | "after" = "before";
  raw = "";
  text = "";

  push(chunk: string): string {
    this.raw += chunk;
    if (this.state === "after") return "";
    this.buf += chunk;
    if (this.state === "before") {
      const i = this.buf.indexOf(OPEN);
      if (i < 0) {
        this.buf = this.buf.slice(-(OPEN.length - 1));
        return "";
      }
      this.buf = this.buf.slice(i + OPEN.length).replace(/^\n/, "");
      this.state = "inside";
    }
    let out: string;
    const j = this.buf.indexOf(CLOSE);
    if (j >= 0) {
      out = this.buf.slice(0, j);
      this.buf = "";
      this.state = "after";
    } else {
      let hold = 0;
      for (let k = Math.min(CLOSE.length - 1, this.buf.length); k > 0; k--) {
        if (CLOSE.startsWith(this.buf.slice(-k))) {
          hold = k;
          break;
        }
      }
      out = this.buf.slice(0, this.buf.length - hold);
      this.buf = this.buf.slice(this.buf.length - hold);
    }
    this.text += out;
    return out;
  }

  result(): string {
    if (this.state === "before") return this.raw.trim(); // model skipped the tags
    return (this.text + (this.state === "inside" ? this.buf : "")).trim();
  }
}

// Analyses are cached so "Analyze" followed by "De-AI it" doesn't pay for the same work twice.
const cache = new Map<string, Analysis>();
export async function cachedAnalyze(text: string, mode: "full" | "fast", judge: boolean, signal?: AbortSignal) {
  const key = `${mode}:${judge}:${text}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = await analyze(text, { mode, judge, signal });
  cache.set(key, result);
  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  return result;
}

export async function humanize(
  original: string,
  opts: HumanizeOptions,
  emit: (e: HumanizeEvent) => void | Promise<void>,
  signal?: AbortSignal,
) {
  const usage: Usage = { input: 0, output: 0, cacheRead: 0 };
  const addUsage = (u: Usage) => {
    usage.input += u.input;
    usage.output += u.output;
    usage.cacheRead += u.cacheRead;
  };

  await emit({ type: "stage", stage: "analyzing", message: "Scoring the original" });
  const before = await cachedAnalyze(original, "full", opts.judge, signal);
  await emit({ type: "before", analysis: before });

  let best = { text: original, score: (await cachedAnalyze(original, "fast", false, signal)).overall, pass: 0 };
  let draft = original;
  let latest: Analysis = before;

  for (let pass = 1; pass <= opts.maxPasses; pass++) {
    await emit({
      type: "stage",
      stage: "rewriting",
      pass,
      message: pass === 1 ? "Rewriting" : `Revising the passages that still score as AI (pass ${pass})`,
    });

    const prompt = pass === 1 ? firstPassPrompt(original, before, opts) : revisionPrompt(original, draft, latest, pass, opts);
    const extractor = new RewriteExtractor();
    const pending: Promise<void>[] = [];
    const response = await llm().stream({
      system: REWRITE_SYSTEM,
      prompt,
      model: config.rewriteModel,
      effort: config.rewriteEffort,
      signal,
      onText: (delta) => {
        const out = extractor.push(delta);
        if (out) pending.push(Promise.resolve(emit({ type: "delta", pass, text: out })));
      },
    });
    await Promise.all(pending);
    addUsage(response.usage);
    // The streamed text is authoritative; fall back to the final text if nothing streamed.
    if (!extractor.raw) extractor.push(response.text);

    draft = extractor.result();
    if (!draft) throw new PipelineError("Claude returned an empty rewrite.");

    await emit({ type: "stage", stage: "scoring", pass, message: "Scoring the draft" });
    latest = await cachedAnalyze(draft, "fast", false, signal);
    const isBest = latest.overall < best.score;
    if (isBest) best = { text: draft, score: latest.overall, pass };
    await emit({ type: "draft", pass, text: draft, analysis: latest, best: isBest });

    if (latest.overall <= opts.targetScore) break;
  }

  await emit({ type: "stage", stage: "checking", message: "Checking that the meaning survived" });
  const [after, fidelityResult] = await Promise.all([
    cachedAnalyze(best.text, "full", opts.judge, signal),
    best.pass === 0 ? Promise.resolve(null) : checkFidelity(original, best.text, signal).then(
      (r) => {
        addUsage(r.usage);
        return r.fidelity;
      },
      (err: Error) => err,
    ),
  ]);

  await emit({
    type: "done",
    text: best.text,
    bestPass: best.pass,
    before,
    after,
    fidelity: fidelityResult instanceof Error ? null : fidelityResult,
    fidelityError: fidelityResult instanceof Error ? fidelityResult.message : undefined,
    usage,
  });
}

async function checkFidelity(original: string, rewrite: string, signal?: AbortSignal) {
  const { data, usage } = await llm().json({
    system: FIDELITY_SYSTEM,
    prompt: fidelityPrompt(original, rewrite),
    model: config.judgeModel,
    effort: "medium",
    schema: FidelitySchema,
    signal,
  });
  return { fidelity: data, usage };
}
