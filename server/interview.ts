// Interview mode: instead of rewriting the article, help the author rewrite it themselves.
// The article is cut into sections, Claude says what each one covers and asks questions that
// draw out the author's own version, and the author's words replace the AI text as written.
// Pangram and GPTZero detect model-chosen wording however it's prompted or restructured
// (tested: 97-100% on every automated rewrite), so the author's own sentences are what count.

import { z } from "zod";
import { PipelineError } from "./claude.ts";
import { config } from "./config.ts";
import { llm } from "./llm.ts";
import { countWords } from "./text.ts";

export interface InterviewSection {
  id: number;
  heading?: string; // Markdown heading line that opens this section, if any
  text: string; // the original (AI) text of the section
  words: number;
  point: string;
  questions: string[];
}

interface Block {
  text: string;
  words: number;
  heading: boolean;
}

function blocks(article: string): Block[] {
  return article
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((text) => ({ text, words: countWords(text), heading: /^#{1,6}\s/.test(text) && !text.includes("\n") }));
}

// Sections follow the article's headings, and long stretches are cut into pieces of roughly
// 140-260 words: enough to make a point in, small enough to write in one sitting.
export function sectionize(article: string) {
  const all = blocks(article);
  const title = all[0]?.heading && /^#\s/.test(all[0].text) ? all.shift()!.text : undefined;
  const sections: { heading?: string; paragraphs: Block[]; words: number }[] = [];
  let heading: string | undefined;
  let current: (typeof sections)[number] | null = null;
  const flush = () => {
    if (current?.paragraphs.length) sections.push(current);
    current = null;
  };
  for (const b of all) {
    if (b.heading) {
      flush();
      heading = b.text;
      continue;
    }
    if (current && current.words > 0 && current.words + b.words > 260) flush();
    current ??= { heading, paragraphs: [], words: 0 };
    heading = undefined;
    current.paragraphs.push(b);
    current.words += b.words;
    if (current.words >= 140) flush();
  }
  flush();

  // A stub left at the end of a heading's run reads better folded into the piece before it.
  for (let i = sections.length - 1; i > 0; i--) {
    const s = sections[i];
    const prev = sections[i - 1];
    if (s.words < 45 && !s.heading && prev.words + s.words <= 320) {
      prev.paragraphs.push(...s.paragraphs);
      prev.words += s.words;
      sections.splice(i, 1);
    }
  }
  return {
    title,
    sections: sections.map((s, i) => ({
      id: i + 1,
      heading: s.heading,
      text: s.paragraphs.map((p) => p.text).join("\n\n"),
      words: s.words,
    })),
  };
}

const PlanSchema = z.object({
  sections: z.array(
    z.object({
      id: z.number().int(),
      point: z.string().describe("What this section says, in one plain sentence, so the author knows what to cover"),
      questions: z.array(z.string()).describe("One or two short questions that draw out the author's own version of this section"),
    }),
  ),
});

const PLAN_SYSTEM = `You help an author take back an article that an AI drafted for them. They are going to rewrite it section by section in their own words, so that readers, and AI detectors, hear a person instead of a model.

For each numbered section, give:
- point: what the section says, in one plain sentence of your own (don't quote the draft), so the author knows what ground to cover.
- questions: one or two short questions that pull the author's own version out of them. Ask for things only the author has: a time they saw this themselves, a real example from their life or work, a detail or number they know firsthand, how they'd put it to a friend, what they honestly think about it. Each should be answerable in a few sentences of plain talk.

Don't suggest wording, don't quote the draft, and don't ask yes/no questions.`;

export async function planInterview(article: string, signal?: AbortSignal) {
  const { title, sections } = sectionize(article);
  if (!sections.length) throw new PipelineError("There's no prose to interview you about.");
  const numbered = sections
    .map((s) => `[${s.id}]${s.heading ? ` (under the heading "${s.heading.replace(/^#+\s*/, "")}")` : ""}\n${s.text}`)
    .join("\n\n");
  const { data } = await llm().json({
    system: PLAN_SYSTEM,
    prompt: `<article>\n${title ? `${title}\n\n` : ""}${numbered}\n</article>\n\nGive the point and questions for each of the ${sections.length} numbered sections.`,
    model: config.judgeModel,
    effort: "medium",
    schema: PlanSchema,
    signal,
  });
  const byId = new Map(data.sections.map((s) => [s.id, s]));
  return {
    title,
    sections: sections.map((s): InterviewSection => ({
      ...s,
      point: byId.get(s.id)?.point ?? "",
      questions: (byId.get(s.id)?.questions ?? []).slice(0, 2),
    })),
  };
}

const ProofreadSchema = z.object({ text: z.string() });

const PROOFREAD_SYSTEM = `You are a proofreader for a writer who wants their own words left alone. Fix only spelling mistakes, typos, capitalization, and missing or wrong punctuation. Never change word choice, word order, sentence structure, contractions, slang, or profanity, and never add, remove, merge, or split sentences. If nothing needs fixing, return the text unchanged.`;

// Words changed between two versions (insertions + deletions beyond the longest common run).
function wordsChanged(a: string[], b: string[]) {
  const dp = new Uint16Array((a.length + 1) * (b.length + 1));
  const w = b.length + 1;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i * w + j] = a[i - 1] === b[j - 1] ? dp[(i - 1) * w + j - 1] + 1 : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
    }
  }
  return Math.max(a.length, b.length) - dp[a.length * w + b.length];
}

const words = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}'’]+/gu) ?? [];

export async function proofread(text: string, signal?: AbortSignal) {
  const { data } = await llm().json({
    system: PROOFREAD_SYSTEM,
    prompt: `<text>\n${text}\n</text>`,
    model: config.judgeModel,
    effort: "low",
    schema: ProofreadSchema,
    signal,
  });
  const before = words(text);
  const changed = wordsChanged(before, words(data.text));
  // Typo fixes touch a word here and there. Anything more is the model rewriting, which would
  // put AI wording back into the author's text, so it's refused.
  if (changed > Math.max(3, before.length * 0.08)) {
    return { text, changed: 0, refused: true };
  }
  return { text: data.text, changed, refused: false };
}
