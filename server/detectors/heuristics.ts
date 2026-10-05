// Stylometric tells of LLM writing. None of these alone proves anything, but
// together they track what commercial detectors pick up on, and unlike a
// classifier they can say *why* a passage reads as machine-written, which is
// what the rewrite step needs to hear.

import { clamp01, type Detection, type Detector, type Signal } from "./types.ts";
import type { Sentence } from "../text.ts";

const A = "['’]"; // straight or curly apostrophe

// [regex source, weight]. Weight 3 = near-certain tell, 1 = mildly overused.
const TELLS: [string, number][] = [
  ["delv(?:e|es|ed|ing)", 3],
  ["tapestr(?:y|ies)", 3],
  ["(?:a |stands as a |serves as a )?testament to", 3],
  ["(?:in )?the realm of", 3],
  ["multifaceted", 3],
  [`it${A}?s (?:important|crucial|essential|vital|worth) (?:to (?:note|remember|understand|recognize|consider)|noting|mentioning)`, 3],
  ["it is (?:important|crucial|essential|vital|worth) (?:to (?:note|remember|understand|recognize|consider)|noting|mentioning)", 3],
  [`in today${A}?s (?:fast-paced|digital|modern|ever-changing|ever-evolving|competitive|interconnected|rapidly changing)(?: \\w+)?`, 3],
  ["ever-(?:evolving|changing) (?:landscape|world|field)", 3],
  ["navigat(?:e|es|ing) the (?:complexities|intricacies|challenges|nuances|world|waters|landscape)", 3],
  ["in conclusion", 3],
  ["embark(?:s|ed|ing)? on", 3],
  ["unlock(?:s|ed|ing)? (?:the )?(?:full )?(?:power|potential|secrets?)", 3],
  ["harness(?:es|ed|ing)? the (?:power|potential)", 3],
  ["game[- ]changer", 3],
  ["look no further", 3],
  [`(?:let${A}?s|let us) (?:dive|delve|explore|take a closer look|unpack|break (?:it|this) down)`, 3],
  ["(?:dive|dives|diving) (?:deep |deeper )?into", 2],
  ["deep dive", 2],
  ["cannot be overstated", 3],
  ["treasure trove", 3],
  ["in the (?:digital|modern) age", 2],
  ["fast-paced", 2],
  ["(?:digital )?landscape", 2],
  ["leverag(?:e|es|ed|ing)", 2],
  ["foster(?:s|ed|ing)?", 2],
  ["robust", 2],
  ["seamless(?:ly)?", 2],
  ["crucial(?:ly)?", 2],
  ["pivotal", 2],
  ["intricac(?:y|ies)|intricate", 2],
  ["comprehensive", 2],
  ["holistic", 2],
  ["paramount", 2],
  ["myriad", 2],
  ["plethora", 2],
  ["underscor(?:e|es|ed|ing)", 2],
  ["showcas(?:e|es|ed|ing)", 2],
  ["elevat(?:e|es|ing) (?:your|the|their|our)", 2],
  ["empower(?:s|ed|ing|ment)?", 2],
  ["streamlin(?:e|es|ed|ing)", 2],
  ["cutting-edge", 2],
  ["transformative", 2],
  ["revolutioni[sz](?:e|es|ed|ing)", 2],
  ["vibrant", 2],
  ["bustling", 2],
  ["nestled", 2],
  ["meticulous(?:ly)?", 2],
  ["resonat(?:e|es|ed|ing)", 2],
  ["invaluable", 2],
  ["unparalleled", 2],
  ["unwavering", 2],
  ["beacon", 2],
  ["cornerstone", 2],
  ["interplay", 2],
  ["bolster(?:s|ed|ing)?", 2],
  ["garner(?:s|ed|ing)?", 2],
  ["spearhead(?:s|ed|ing)?", 2],
  ["endeavou?rs?", 2],
  ["synerg(?:y|ies|istic)", 2],
  ["paradigm", 2],
  ["nuanced", 2],
  ["moreover", 2],
  ["furthermore", 2],
  ["additionally", 2],
  ["first and foremost", 2],
  ["when it comes to", 2],
  ["a (?:wide|diverse|broad|vast) (?:range|array|variety|spectrum) of", 2],
  ["plays? an? (?:crucial|vital|key|pivotal|significant|important|central) role", 2],
  ["(?:valuable|actionable|key) insights", 2],
  ["ahead of the curve", 2],
  ["key takeaways?", 2],
  ["in summary|to summarize|all in all", 2],
  ["top[- ]of[- ]mind", 2],
  ["notably", 2],
  ["commendable", 2],
  ["profound(?:ly)?", 1],
  ["ultimately", 1],
  ["essentially", 1],
  ["dynamic", 1],
  ["captivating|intriguing", 1],
  ["enhanc(?:e|es|ed|ing|ement)", 1],
  ["optimi[sz](?:e|es|ed|ing)", 1],
  ["utili[sz](?:e|es|ed|ing|ation)", 1],
  ["facilitat(?:e|es|ed|ing)", 1],
  ["journey", 1],
  ["the power of", 1],
  ["more than just", 1],
  ["two-way street", 1],
  ["at the end of the day", 1],
  [`it${A}?s no secret`, 2],
  ["in a world (?:where|of|that)", 2],
  [`there${A}?s nothing (?:quite )?(?:like|as)`, 2],
  [`you${A}?re not alone`, 2],
  ["the good news is", 2],
  ["(?:are|is) (?:not )?created equal", 2],
  ["in no time", 2],
  ["the bottom line", 2],
  ["make(?:s)? (?:all the|a (?:big|huge|real|noticeable|world of)) difference", 2],
  ["a must-have", 2],
  ["think of (?:it|this) as", 1],
  [`here${A}?s (?:why|how)`, 1],
  ["remarkabl(?:e|y)", 1],
  ["packed with", 1],
  ["kick-?start", 1],
  ["stand(?:s)? out", 1],
  ["peace of mind", 2],
  ["(?:rest assured|needless to say)", 2],
  ["(?:the|a) key (?:factor|component|element|ingredient|aspect)", 2],
  ["navigat(?:e|es|ing)", 1],
];

const TELL_RE = TELLS.map(([src, weight]) => ({ re: new RegExp(`\\b(?:${src})\\b`, "gi"), weight }));

const CONSTRUCTIONS: { re: RegExp; note: string; weight: number }[] = [
  { re: new RegExp(`\\bnot (?:just|only|merely|simply) (?:about )?[^.!?;]{1,80}?(?:,|—|–|-|;)\\s*(?:but|it${A}?s|they${A}?re|this is)\\b`, "i"), note: "\"not just X, but Y\" construction", weight: 2 },
  { re: /\bnot only\b[^.!?]{1,120}\bbut(?: also)?\b/i, note: "\"not only… but also\"", weight: 2 },
  { re: new RegExp(`\\bwhether (?:you${A}?re|you are|it${A}?s|it is|you)\\b[^.!?]{1,100}\\bor\\b`, "i"), note: "\"whether you're X or Y\"", weight: 2 },
  { re: /,\s+(?:ensuring|highlighting|showcasing|making it|allowing|enabling|creating|fostering|underscoring|emphasizing|reflecting|providing|offering|paving|resulting in|helping|leading to|solidifying|cementing)\b[^.!?]*[.!?]?$/i, note: "trailing \"-ing\" clause", weight: 2 },
  { re: /\b(?:the|your|the real) (?:result|answer|outcome|catch|kicker|secret|truth|best part|bottom line|takeaway|twist)\?/i, note: "rhetorical \"The result?\" setup", weight: 2 },
  { re: new RegExp(`\\bhere${A}?s (?:the thing|the kicker|the deal|the catch|the truth)\\b`, "i"), note: "\"here's the thing\"", weight: 2 },
  { re: /^from [^,]{2,50} to [^,]{2,50},/i, note: "\"From X to Y,\" opener", weight: 2 },
  { re: /\b(?:is|are|remains|remain) key\b/i, note: "\"X is key\"", weight: 1 },
  { re: new RegExp(`\\b(?:isn${A}?t|is not|aren${A}?t|are not|wasn${A}?t)\\s+(?:just\\s+|only\\s+|really\\s+)?about\\b[^.!?]{1,80}?(?:;|,|—|–|\\.)\\s*(?:it${A}?s|it is|they${A}?re|it${A}?s really)\\s+(?:about\\b)?`, "i"), note: "\"isn't about X, it's about Y\"", weight: 2 },
];

const TITLE_CASE_SMALL = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with", "your", "is", "it"]);
function isTitleCase(heading: string) {
  const words = heading.replace(/^#+\s*/, "").match(/[A-Za-z][\w'’-]*/g) ?? [];
  if (words.length < 3) return false;
  const content = words.slice(1).filter((w) => !TITLE_CASE_SMALL.has(w.toLowerCase()));
  return content.length >= 2 && content.every((w) => /^[A-Z]/.test(w));
}
const CONCLUSION_HEADING = /\b(?:conclusion|bottom line|final thoughts|wrapping (?:it )?up|key takeaways?|the takeaway|in summary|summing up|final word)\b/i;

const TRANSITION_OPENER =
  /^(?:additionally|moreover|furthermore|in addition|however|ultimately|overall|importantly|consequently|therefore|thus|as a result|in conclusion|in summary|notably|indeed|similarly|conversely|nevertheless|nonetheless|hence|firstly|secondly|thirdly|lastly|first and foremost|that said|with that in mind|by doing so|in essence|essentially|in today's|in this article|to sum up|all in all)\b/i;

const TRIPLET = /\b[\w'’-]+(?:\s+[\w'’-]+){0,3},\s+[\w'’-]+(?:\s+[\w'’-]+){0,3},\s+(?:and|or)\s+[\w'’-]+/i;
const CONCLUSION_OPENER = /^(?:in conclusion|in summary|to sum up|ultimately|overall|all in all|in the end|by (?:\w+ing)|so,? whether|as we|remember,)/i;
const EM_DASH = /—|\s–\s|\s--\s/g;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
function cv(xs: number[]) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = mean(xs.map((x) => (x - m) ** 2));
  return m ? Math.sqrt(variance) / m : 0;
}
const ramp = (x: number, human: number, ai: number) => clamp01((x - human) / (ai - human));

export function analyzeStyle(sentences: Sentence[]): Detection {
  const headings = sentences.filter((s) => s.kind === "heading");
  const prose = sentences.filter((s) => s.kind !== "heading" && s.words > 0);
  const totalWords = prose.reduce((n, s) => n + s.words, 0) || 1;
  const per100 = 100 / totalWords;

  const sentenceScores: Record<number, number> = {};
  const sentenceNotes: Record<number, string[]> = {};
  const tellCounts = new Map<string, number>();
  let tellPoints = 0;
  let constructionHits = 0;
  let transitionHits = 0;
  let tripletHits = 0;
  let emDashes = 0;

  for (const s of [...headings, ...prose]) {
    const notes: string[] = [];
    let points = 0;

    for (const { re, weight } of TELL_RE) {
      for (const m of s.text.matchAll(re)) {
        const phrase = m[0].toLowerCase();
        tellCounts.set(phrase, (tellCounts.get(phrase) ?? 0) + 1);
        tellPoints += weight;
        points += weight;
        notes.push(`stock phrase "${phrase}"`);
      }
    }
    if (s.kind === "heading") {
      if (isTitleCase(s.text)) notes.push("Title Case heading");
      if (notes.length) sentenceNotes[s.index] = notes;
      sentenceScores[s.index] = 1 - Math.exp(-points / 3);
      continue;
    }
    for (const c of CONSTRUCTIONS) {
      if (c.re.test(s.text)) {
        constructionHits++;
        points += c.weight;
        notes.push(c.note);
      }
    }
    const opener = s.text.replace(/^[-*+•>\d.)\s"“]+/, "").match(TRANSITION_OPENER);
    if (opener) {
      transitionHits++;
      points += 1.5;
      notes.push(`opens with "${opener[0]}"`);
    }
    if (TRIPLET.test(s.text)) {
      tripletHits++;
      points += 1;
      notes.push("list of three");
    }
    const dashes = s.text.match(EM_DASH)?.length ?? 0;
    emDashes += dashes;
    if (dashes) {
      points += 0.5 * dashes;
      notes.push(dashes > 1 ? `${dashes} em-dashes` : "em-dash");
    }

    sentenceScores[s.index] = 1 - Math.exp(-points / 3);
    if (notes.length) sentenceNotes[s.index] = notes;
  }

  const lengths = prose.filter((s) => s.kind === "prose").map((s) => s.words);
  const paragraphs = new Map<number, number>();
  for (const s of prose) if (s.kind === "prose") paragraphs.set(s.paragraph, (paragraphs.get(s.paragraph) ?? 0) + s.words);
  const paraLengths = [...paragraphs.values()];
  const lastParagraph = prose.filter((s) => s.kind === "prose").at(-1)?.paragraph;
  const lastOpener = prose.find((s) => s.paragraph === lastParagraph)?.text ?? "";
  const lastHeading = headings.at(-1);
  const wrapUp =
    CONCLUSION_OPENER.test(lastOpener) ||
    (lastHeading !== undefined && lastHeading.index > (prose.at(-1)?.index ?? 0) - 6 && CONCLUSION_HEADING.test(lastHeading.text));
  const titleCaseHeadings = headings.filter((h) => isTitleCase(h.text)).length;

  const n = prose.length || 1;
  const sentenceCv = cv(lengths);
  const shortShare = lengths.filter((w) => w <= 7).length / (lengths.length || 1);
  const paraCv = cv(paraLengths);
  const enoughSentences = lengths.length >= 5;
  const enoughParagraphs = paraLengths.length >= 4;

  const signals: (Signal & { weight: number })[] = [
    {
      id: "tells",
      label: "Stock AI vocabulary",
      value: `${(tellPoints * per100).toFixed(1)} pts / 100 words`,
      score: clamp01((tellPoints * per100) / 3.5),
      hint: "Words and phrases LLMs overuse: delve, landscape, foster, crucial, \"it's important to note\"…",
      weight: 3,
    },
    {
      id: "burstiness",
      label: "Sentence-length variety",
      value: enoughSentences ? `CV ${sentenceCv.toFixed(2)}` : "too short to judge",
      score: enoughSentences ? ramp(sentenceCv, 0.7, 0.32) : 0.5,
      hint: "People mix short and long sentences. Models keep them uniform (low coefficient of variation).",
      weight: enoughSentences ? 2 : 0,
    },
    {
      id: "short",
      label: "Short sentences",
      value: `${Math.round(shortShare * 100)}% of sentences ≤ 7 words`,
      score: enoughSentences ? ramp(shortShare, 0.15, 0.02) : 0.5,
      hint: "Human writers drop in short, punchy sentences. Models rarely do.",
      weight: enoughSentences ? 1 : 0,
    },
    {
      id: "constructions",
      label: "Stock constructions",
      value: `${constructionHits} found`,
      score: clamp01(constructionHits / (n * 0.12)),
      hint: "\"Not just X, but Y\", \"whether you're…\", trailing \"…, ensuring that\" clauses, \"The result?\"",
      weight: 1.5,
    },
    {
      id: "transitions",
      label: "Transition-word openers",
      value: `${Math.round((transitionHits / n) * 100)}% of sentences`,
      score: ramp(transitionHits / n, 0.04, 0.18),
      hint: "Sentences starting with Additionally / Moreover / Furthermore / Ultimately.",
      weight: 1.5,
    },
    {
      id: "triplets",
      label: "Lists of three",
      value: `${Math.round((tripletHits / n) * 100)}% of sentences`,
      score: ramp(tripletHits / n, 0.06, 0.3),
      hint: "Models reach for \"X, Y, and Z\" constantly.",
      weight: 1,
    },
    {
      id: "paragraphs",
      label: "Paragraph uniformity",
      value: enoughParagraphs ? `CV ${paraCv.toFixed(2)}` : "too few paragraphs",
      score: enoughParagraphs ? ramp(paraCv, 0.6, 0.2) : 0.5,
      hint: "Model output tends toward evenly sized paragraphs.",
      weight: enoughParagraphs ? 1 : 0,
    },
    {
      id: "dashes",
      label: "Em-dashes",
      value: `${(emDashes * per100).toFixed(1)} / 100 words`,
      score: ramp(emDashes * per100, 0.3, 1.5),
      hint: "Recent models lean hard on em-dashes.",
      weight: 0.5,
    },
    {
      id: "conclusion",
      label: "Wrap-up ending",
      value: wrapUp ? "yes" : "no",
      score: wrapUp ? 1 : 0,
      hint: "A closing \"In conclusion\" / \"The Bottom Line\" section, or a last paragraph opening \"Ultimately\" / \"By doing X, you can…\".",
      weight: 0.75,
    },
    {
      id: "headings",
      label: "Title Case headings",
      value: headings.length ? `${titleCaseHeadings} of ${headings.length}` : "no headings",
      score: headings.length >= 2 ? titleCaseHeadings / headings.length : 0,
      hint: "Generated articles tend to Title Case Every Heading.",
      weight: headings.length >= 2 ? 0.5 : 0,
    },
  ];

  const weightSum = signals.reduce((a, s) => a + s.weight, 0);
  const raw = signals.reduce((a, s) => a + s.score * s.weight, 0) / (weightSum || 1);
  // Stretch the middle so clearly human and clearly AI text land near the ends of the scale.
  const score = 1 / (1 + Math.exp(-9 * (raw - 0.42)));

  const tells = [...tellCounts.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count);

  return {
    score,
    sentenceScores,
    sentenceNotes,
    signals: signals.map(({ weight: _w, ...s }) => s),
    tells,
    detail: `${tells.reduce((a, t) => a + t.count, 0)} stock phrases, ${constructionHits} stock constructions`,
  };
}

export const heuristics: Detector = {
  id: "style",
  name: "Style tells",
  kind: "local",
  weight: 1.5,
  fast: true,
  enabled: () => true,
  detect: async (_text, sentences) => analyzeStyle(sentences),
};
