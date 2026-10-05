import type { Sentence } from "../text.ts";

export type DetectorKind = "local" | "llm" | "external";

export interface Signal {
  id: string;
  label: string;
  value: string;
  score: number; // 0 = reads human, 1 = reads AI
  hint: string;
}

export interface Detection {
  score: number; // 0..1 likelihood the text is AI-generated
  sentenceScores?: Record<number, number>;
  sentenceNotes?: Record<number, string[]>;
  detail?: string;
  signals?: Signal[];
  tells?: { phrase: string; count: number }[];
}

export interface DetectorResult extends Partial<Detection> {
  id: string;
  name: string;
  kind: DetectorKind;
  weight: number;
  noisy?: boolean;
  ms: number;
  error?: string;
}

export interface Detector {
  id: string;
  name: string;
  kind: DetectorKind;
  weight: number;
  // Noisy detectors (known blind spots or false positives) count toward the average but can't
  // set the overall score on their own.
  noisy?: boolean;
  // Fast detectors run on every pass of the rewrite loop; slow/paid ones only on full analyses.
  fast: boolean;
  enabled(): boolean;
  detect(text: string, sentences: Sentence[], signal?: AbortSignal): Promise<Detection>;
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// Spread span-level scores (from a detector with its own segmentation) onto our sentences.
export function spansToSentences(
  sentences: Sentence[],
  spans: { start: number; end: number; score: number }[],
): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of sentences) {
    let total = 0;
    let weight = 0;
    for (const span of spans) {
      const overlap = Math.min(s.end, span.end) - Math.max(s.start, span.start);
      if (overlap > 0) {
        total += span.score * overlap;
        weight += overlap;
      }
    }
    if (weight > 0) out[s.index] = total / weight;
  }
  return out;
}

// Find detector-returned sentence strings in the original text, in order, to recover offsets.
export function locate(text: string, items: { text: string; score: number }[]) {
  const spans: { start: number; end: number; score: number }[] = [];
  let cursor = 0;
  for (const item of items) {
    const needle = item.text.trim();
    if (!needle) continue;
    let at = text.indexOf(needle, cursor);
    if (at < 0) at = text.indexOf(needle);
    if (at < 0) continue;
    spans.push({ start: at, end: at + needle.length, score: item.score });
    cursor = at + needle.length;
  }
  return spans;
}
