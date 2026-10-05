// Splitting articles into sentences (with character offsets back into the
// original text) and grouping sentences into chunks for the detectors.

export type SentenceKind = "prose" | "list" | "heading";

export interface Sentence {
  index: number;
  text: string;
  start: number;
  end: number;
  paragraph: number;
  kind: SentenceKind;
  words: number;
}

export interface Chunk {
  text: string;
  sentences: number[];
  words: number;
}

const HEADING = /^\s{0,3}#{1,6}\s/;
const LIST_ITEM = /^\s{0,3}([-*+•]|\d{1,3}[.)])\s+/;
const QUOTE_OR_TABLE = /^\s{0,3}(>|\|)/;

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });

export function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

interface Unit {
  start: number;
  end: number;
  paragraph: number;
  kind: SentenceKind;
}

// Lines are grouped into units: a heading or list item is its own unit, and
// runs of ordinary lines (including hard-wrapped paragraphs) form one prose unit.
function units(text: string): Unit[] {
  const out: Unit[] = [];
  let paragraph = -1;
  let prevBlank = true;
  let current: Unit | null = null;
  let offset = 0;

  for (const line of text.split("\n")) {
    const start = offset;
    const end = offset + line.length;
    offset = end + 1;

    if (line.trim() === "") {
      current = null;
      prevBlank = true;
      continue;
    }
    if (prevBlank) paragraph++;
    prevBlank = false;

    const kind: SentenceKind | null = HEADING.test(line)
      ? "heading"
      : LIST_ITEM.test(line) || QUOTE_OR_TABLE.test(line)
        ? "list"
        : null;

    if (kind) {
      current = { start, end, paragraph, kind };
      out.push(current);
      if (kind === "heading") current = null;
    } else if (current) {
      // Continuation of the previous prose block or list item.
      current.end = end;
    } else {
      current = { start, end, paragraph, kind: "prose" };
      out.push(current);
    }
  }
  return out;
}

export function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  for (const unit of units(text)) {
    const raw = text.slice(unit.start, unit.end);
    if (unit.kind === "heading") {
      push(raw, unit.start, unit);
      continue;
    }
    // Same-length newline replacement keeps offsets valid; ICU would otherwise
    // break a sentence at every hard line wrap.
    const flat = raw.replace(/\n/g, " ");
    for (const seg of segmenter.segment(flat)) {
      push(raw.slice(seg.index, seg.index + seg.segment.length), unit.start + seg.index, unit);
    }
  }
  return sentences;

  function push(piece: string, at: number, unit: Unit) {
    const lead = piece.length - piece.trimStart().length;
    const trimmed = piece.trim();
    if (!trimmed) return;
    sentences.push({
      index: sentences.length,
      text: trimmed.replace(/\s*\n\s*/g, " "),
      start: at + lead,
      end: at + lead + trimmed.length,
      paragraph: unit.paragraph,
      kind: unit.kind,
      words: countWords(trimmed),
    });
  }
}

// Plain prose for the classifiers. They're trained on unformatted text and are
// surprisingly sensitive to layout: paragraph breaks alone can swing a score from
// 3% to 98% on the same words, so Markdown, footnote markers, and line breaks go.
export function plain(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url) and images
    .replace(/\[\d{1,3}\]/g, "") // footnote markers
    .replace(/^\s{0,3}(#{1,6}|>|[-*+•]|\d{1,3}[.)])\s+/gm, "") // headings, quotes, list bullets
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, "$2") // emphasis and code spans
    .replace(/\s+/g, " ")
    .trim();
}

function join(sentences: Sentence[], ids: number[]): string {
  return plain(ids.map((id) => sentences[id].text).join(" "));
}

const scorable = (s: Sentence) => s.kind !== "heading" && s.words > 0;

// Non-overlapping chunks covering the whole article, for document-level scores.
// Classifiers are most accurate with a few hundred words of context.
export function documentChunks(sentences: Sentence[], maxWords = 280): Chunk[] {
  const chunks: Chunk[] = [];
  let ids: number[] = [];
  let words = 0;
  const flush = () => {
    if (ids.length) chunks.push({ text: join(sentences, ids), sentences: ids, words });
    ids = [];
    words = 0;
  };
  for (const s of sentences.filter(scorable)) {
    if (words > 0 && words + s.words > maxWords) flush();
    ids.push(s.index);
    words += s.words;
  }
  flush();

  // A tiny trailing chunk scores unreliably; fold it into the previous one if it fits.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const prev = chunks[chunks.length - 2];
    if (last.words < 60 && prev.words + last.words <= maxWords * 1.3) {
      prev.sentences.push(...last.sentences);
      prev.words += last.words;
      prev.text = join(sentences, prev.sentences);
      chunks.pop();
    }
  }
  return chunks;
}

// Overlapping windows of a few sentences, for localizing which passages read as AI.
// Each sentence ends up in roughly two windows.
export function slidingWindows(sentences: Sentence[], targetWords = 100, maxWords = 220): Chunk[] {
  const pool = sentences.filter(scorable);
  const windows: Chunk[] = [];
  let i = 0;
  while (i < pool.length) {
    const ids: number[] = [];
    let words = 0;
    let j = i;
    while (j < pool.length && (words < targetWords || ids.length < 2)) {
      if (words > 0 && words + pool[j].words > maxWords) break;
      ids.push(pool[j].index);
      words += pool[j].words;
      j++;
    }
    windows.push({ text: join(sentences, ids), sentences: ids, words });
    if (j >= pool.length) break;
    i += Math.max(1, Math.floor(ids.length / 2));
  }
  return windows;
}
