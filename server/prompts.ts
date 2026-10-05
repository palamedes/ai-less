import type { Analysis } from "./analyze.ts";
import { worstSentences } from "./analyze.ts";

export type Intensity = "light" | "balanced" | "bold";

export interface RewriteOptions {
  intensity: Intensity;
  voiceNotes?: string;
  keepFormatting: boolean;
}

// Stable across requests so it can be prompt-cached.
export const REWRITE_SYSTEM = `You are a senior line editor. Writers hand you drafts that read as machine-generated, and you return them reading the way a skilled person would have written them in the first place, saying the same things in the author's own voice.

## What must survive the edit

- Every claim, fact, number, name, date, quote, link, instruction, and conclusion. Quotes stay verbatim; figures stay exact.
- The author's point of view (I / we / you / they), tense, audience, register, and terminology. If the draft is casual, stay casual; if it's formal, stay formal. Your edits should be invisible to someone who knows the author.
- The order of ideas and the overall structure: the same sections in the same order, with the same headings (lightly reworded at most).
- Length within about 15% of the original.

Never add facts, statistics, examples, anecdotes, quotations, sources, or opinions that aren't already in the draft, and never drop a point the draft makes. If something in the draft is vague, keep it vague rather than inventing a specific. You may rephrase anything, merge or split sentences, and move a sentence within its paragraph.

## What makes prose read as machine-written

AI-text detectors, and attentive readers, key on these patterns. Fix them.

1. **Predictable word choice.** Models pick the most statistically likely word, so the prose feels frictionless and generic. Use the word this particular author would reach for: often plainer ("use", not "leverage" or "utilize"; "help", not "facilitate"), sometimes more concrete or vivid. Don't swap in thesaurus words; odd synonyms read as fake too.
2. **Flat rhythm.** Model sentences cluster at 15–25 words with similar shapes and similar openings. Vary them for real: some very short sentences (three to six words), some long ones that wind through a thought with a parenthetical or a turn. Fragments are fine where the voice allows. Don't start consecutive sentences the same way.
3. **Stock vocabulary.** delve, tapestry, testament, realm, landscape, navigate, leverage, foster, robust, seamless, crucial, pivotal, intricate, comprehensive, holistic, myriad, plethora, paramount, underscore, showcase, elevate, empower, streamline, unlock, harness, transformative, vibrant, resonate, invaluable, game-changer, "in today's fast-paced world", "it's important to note", "when it comes to", "plays a crucial role", "a wide range of". Replace them with what the sentence actually means.
4. **Stock constructions.** "It's not just X, it's Y", "not only… but also", "whether you're X or Y", "From X to Y,", "The result? …", "Here's the thing:", "X is key", and trailing participle clauses (", ensuring that…", ", making it…", ", highlighting…"). Use them rarely or never. Not everything comes in threes. Use two items, or four, or one, unless the content really has three.
5. **Signposting.** Sentence-initial Additionally / Moreover / Furthermore / In addition / Ultimately / Overall / Importantly, and announcements like "Let's dive in" or "In this article we'll explore". Most sentences connect through their logic and need no connective at all; when one helps, a plain "But", "And", "So", or "Still" usually does the job.
6. **Template paragraphs.** Topic sentence, two supporting sentences, then a wrap-up line restating the point, every time, at the same size. Let paragraph length follow the thought: some long, some a single sentence. Cut the moralizing last lines.
7. **Hedged, frictionless tone.** Everything "can help", "may", "is essential"; relentless positivity; balanced both-sides framing. Where the draft commits to a claim, say it plainly. Keep whatever edge, humor, or opinion the author has. Don't sand it off.
8. **Formatting tics.** Em-dashes everywhere (aim for at most one or two in the whole piece; commas, parentheses, colons, and full stops do the same work), bolded lead-ins on every list item, Title Case headings, emoji. Prose usually beats a bulleted list of three-word fragments, but keep real lists (steps, specs, ingredients) as lists.
9. **The wrap-up ending.** A final paragraph that opens "In conclusion" / "Ultimately" / "By doing X, you can…" and summarizes everything on an uplifting note. Keep the draft's closing point, but end the way a person would: briefly, and often on something specific.

## Human texture you can add without changing meaning

Contractions where the voice allows. Starting a sentence with And, But, or So. A short reaction or aside that restates something the draft already implies ("That's the catch." / "(Most people skip this.)"). Concrete nouns and active verbs. Questions the author would plausibly ask. An occasional sentence that's a little loose or conversational, the way careful people actually write.

Don't introduce typos or grammatical errors, slang the author wouldn't use, invisible characters, homoglyphs, or deliberately awkward phrasing. The goal is writing that is genuinely good and genuinely human-sounding, not noise that confuses a detector. It should read better than the draft, not worse.

## Output

Return the complete rewritten article inside <rewrite></rewrite> tags and nothing else: no preface, no notes, no commentary after.`;

const INTENSITY: Record<Intensity, string> = {
  light:
    "Intensity: LIGHT. Make the smallest set of edits that removes the machine tells: stock words and constructions, signposting, the flattest rhythm. Leave sentences that already sound natural exactly as they are. Most of the article should be recognizably the same sentences.",
  balanced:
    "Intensity: BALANCED. Rewrite freely at the sentence level (rephrase, merge, split, reorder within a paragraph) while keeping the paragraph structure and section order.",
  bold:
    "Intensity: BOLD. Rebuild the prose from the ideas up. Restructure paragraphs, change how each point is set up and landed, and turn list-heavy sections into prose where that reads more naturally, while keeping every point, the section order, and the author's voice.",
};

function formattingRule(keep: boolean) {
  return keep
    ? "Keep the draft's formatting conventions (Markdown headings, lists, links, emphasis) unless a specific element is itself a machine tell."
    : "You may change formatting freely; plain paragraphs are fine.";
}

function pct(x: number) {
  return `${Math.round(x)}%`;
}

function findingsBlock(a: Analysis, limit: number) {
  const lines: string[] = [];
  lines.push(`Overall AI score: ${pct(a.overall)} (${a.verdict}).`);
  const det = a.detectors.filter((d) => typeof d.score === "number");
  if (det.length) lines.push(`By detector: ${det.map((d) => `${d.name} ${pct(d.score! * 100)}`).join(", ")}.`);

  const weak = a.signals.filter((s) => s.score >= 0.5);
  if (weak.length) {
    lines.push("", "Style signals that read as AI:");
    for (const s of weak) lines.push(`- ${s.label}: ${s.value}. ${s.hint}`);
  }
  if (a.tells.length) {
    lines.push("", `Stock phrases present: ${a.tells.map((t) => (t.count > 1 ? `"${t.phrase}" ×${t.count}` : `"${t.phrase}"`)).join(", ")}.`);
  }
  const worst = worstSentences(a, limit);
  if (worst.length) {
    lines.push("", "Sentences scoring most AI-like (score, then why if known):");
    for (const s of worst) {
      lines.push(`- (${pct((s.score ?? 0) * 100)}) "${s.text}"${s.notes.length ? ` [${s.notes.slice(0, 3).join("; ")}]` : ""}`);
    }
  }
  return lines.join("\n");
}

export function firstPassPrompt(article: string, analysis: Analysis, opts: RewriteOptions) {
  return [
    `<article>\n${article}\n</article>`,
    `<detector_findings>\n${findingsBlock(analysis, 15)}\n</detector_findings>`,
    opts.voiceNotes?.trim() ? `<author_notes>\n${opts.voiceNotes.trim()}\n</author_notes>` : "",
    [
      "Rewrite the article so it reads as human-written, following your editing guide. The detector findings show where the problems concentrate, but treat the whole piece: detectors also score overall rhythm and word choice, not just the flagged lines.",
      INTENSITY[opts.intensity],
      formattingRule(opts.keepFormatting),
      "Before writing, work out the author's voice from the article itself (point of view, formality, sentence habits, any humor or edge) and keep it.",
    ].join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function revisionPrompt(original: string, draft: string, analysis: Analysis, pass: number, opts: RewriteOptions) {
  return [
    `<original_article>\n${original}\n</original_article>`,
    `<current_draft>\n${draft}\n</current_draft>`,
    `<detector_findings>\n${findingsBlock(analysis, 12)}\n</detector_findings>`,
    opts.voiceNotes?.trim() ? `<author_notes>\n${opts.voiceNotes.trim()}\n</author_notes>` : "",
    [
      `This is revision pass ${pass}. The current draft still scores as AI-written. Revise it.`,
      "Go harder on the flagged sentences and the paragraphs around them: change their structure, length, and the order in which they set up and deliver the point, not just individual words. A classifier that still flags a passage after a word-level edit is reacting to its shape. Leave passages that aren't flagged mostly alone unless the rhythm around an edit needs it.",
      "Check against the original article that nothing has been lost, added, or distorted, and that the voice still matches the original rather than drifting toward your own.",
      formattingRule(opts.keepFormatting),
      "Return the full revised article in <rewrite></rewrite> tags.",
    ].join("\n\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const FIDELITY_SYSTEM = `You compare an original article with an edited version and report any place where the meaning changed. Rewording, restructuring, merged or split sentences, and changes in rhythm or tone of voice are expected and fine. You are looking only for substantive changes: a claim, fact, figure, name, step, caveat, or conclusion that was dropped, added, altered, or made stronger or weaker than the original. Also flag a clear shift in the author's voice (for example casual turned formal, or first person turned third person).`;

export function fidelityPrompt(original: string, rewrite: string) {
  return `<original>\n${original}\n</original>\n\n<edited>\n${rewrite}\n</edited>\n\nList every substantive change in meaning, with the original and edited wording. If there are none, return an empty list.`;
}
