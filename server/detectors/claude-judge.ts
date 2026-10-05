// A second opinion from Claude. LLMs are mediocre at *scoring* AI text, so this
// carries a low weight, but they're good at pointing to the specific sentences
// that sound canned and saying why.

import { z } from "zod";
import { config } from "../config.ts";
import { llm, llmStatus } from "../llm.ts";
import { clamp01, type Detection, type Detector } from "./types.ts";

const Judgement = z.object({
  ai_likelihood: z.number().describe("0-100: how likely this was produced by an AI model with little human editing"),
  verdict: z.string().describe("One or two plain sentences explaining the call"),
  flagged: z
    .array(
      z.object({
        sentence: z.number().int().describe("The [n] number of the sentence"),
        reason: z.string().describe("Why it reads machine-written, in under 12 words"),
      }),
    )
    .describe("The sentences that read most machine-written, most obvious first. At most 15."),
});

const SYSTEM = `You are a forensic editor who has read thousands of human-written and AI-generated articles and can tell them apart.

Judge the article on how it is written, not on its topic or quality. Signals of AI generation include: predictable word choice, stock vocabulary (delve, landscape, foster, crucial, robust, seamless, "it's important to note"), uniform sentence length and rhythm, formulaic transitions (Additionally, Moreover, Ultimately), "not just X, but Y" and "whether you're X or Y" constructions, reflexive lists of three, trailing ", ensuring that…" clauses, generic hedged claims with no specifics, evenly sized paragraphs that each end on a summary line, heavy em-dash use, and a wrap-up conclusion that restates everything. Signals of a human author include idiosyncratic word choice, uneven rhythm, specific concrete detail, opinions with some edge, asides, and structure that follows the thinking rather than a template.

Well-edited human writing can be polished, and light AI assistance is common; reserve very high scores for text that is clearly generated.`;

export const claudeJudge: Detector = {
  id: "claude",
  name: "Claude read",
  kind: "llm",
  weight: 1,
  fast: false,
  enabled: () => llmStatus.ok,
  async detect(_text, sentences, signal): Promise<Detection> {
    const numbered = sentences.map((s) => `[${s.index}] ${s.text}`).join("\n");
    const { data: out } = await llm().json({
      system: SYSTEM,
      prompt: `Here is the article, one sentence per line with its number:\n\n<article>\n${numbered}\n</article>\n\nHow likely is it that this was AI-generated, and which sentences give it away?`,
      model: config.judgeModel,
      effort: config.judgeEffort,
      schema: Judgement,
      signal,
    });
    const score = clamp01(out.ai_likelihood / 100);
    const flagged = new Map(out.flagged.map((f) => [f.sentence, f.reason]));
    const sentenceScores: Record<number, number> = {};
    const sentenceNotes: Record<number, string[]> = {};
    for (const s of sentences) {
      if (s.kind === "heading") continue;
      const reason = flagged.get(s.index);
      sentenceScores[s.index] = reason ? Math.max(0.8, score) : score * 0.6;
      if (reason) sentenceNotes[s.index] = [reason];
    }
    return { score, sentenceScores, sentenceNotes, detail: out.verdict };
  },
};
