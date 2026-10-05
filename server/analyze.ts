import { describeClaudeError } from "./claude.ts";
import { claudeJudge } from "./detectors/claude-judge.ts";
import { externalDetectors } from "./detectors/external.ts";
import { heuristics } from "./detectors/heuristics.ts";
import { localDetectors } from "./detectors/local-models.ts";
import type { Detection, Detector, DetectorResult, Signal } from "./detectors/types.ts";
import { countWords, splitSentences, type Sentence } from "./text.ts";

export const detectors: Detector[] = [heuristics, ...localDetectors, claudeJudge, ...externalDetectors];

export interface SentenceView extends Omit<Sentence, "words"> {
  score: number | null;
  notes: string[];
}

export interface Analysis {
  overall: number; // 0-100
  verdict: string;
  words: number;
  mode: "full" | "fast";
  detectors: Omit<DetectorResult, "sentenceScores" | "sentenceNotes" | "signals" | "tells">[];
  sentences: SentenceView[];
  signals: Signal[];
  tells: { phrase: string; count: number }[];
}

export interface AnalyzeOptions {
  mode: "full" | "fast";
  judge?: boolean;
  signal?: AbortSignal;
}

export function verdict(overall: number) {
  if (overall < 20) return "Reads human";
  if (overall < 45) return "Mostly human, some AI tells";
  if (overall < 70) return "Mixed: likely AI-assisted";
  return "Reads AI-generated";
}

async function run(d: Detector, text: string, sentences: Sentence[], signal?: AbortSignal): Promise<DetectorResult> {
  const t0 = performance.now();
  const base = { id: d.id, name: d.name, kind: d.kind, weight: d.weight };
  try {
    const result: Detection = await d.detect(text, sentences, signal);
    return { ...base, ...result, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    const error = d.kind === "llm" ? describeClaudeError(err) : (err as Error).message;
    return { ...base, error, ms: Math.round(performance.now() - t0) };
  }
}

export async function analyze(text: string, opts: AnalyzeOptions): Promise<Analysis> {
  const sentences = splitSentences(text);
  const active = detectors.filter(
    (d) => d.enabled() && (opts.mode === "full" || d.fast) && (d.id !== "claude" || opts.judge),
  );
  const results = await Promise.all(active.map((d) => run(d, text, sentences, opts.signal)));
  const ok = results.filter((r) => r.error === undefined && typeof r.score === "number");

  const weightSum = ok.reduce((a, r) => a + r.weight, 0);
  const overall = weightSum ? (100 * ok.reduce((a, r) => a + r.score! * r.weight, 0)) / weightSum : 0;

  const views: SentenceView[] = sentences.map(({ words: _w, ...s }) => {
    let total = 0;
    let weight = 0;
    const notes: string[] = [];
    for (const r of ok) {
      const v = r.sentenceScores?.[s.index];
      if (typeof v === "number") {
        total += v * r.weight;
        weight += r.weight;
      }
      for (const note of r.sentenceNotes?.[s.index] ?? []) if (!notes.includes(note)) notes.push(note);
    }
    return { ...s, score: weight ? total / weight : null, notes };
  });

  const style = results.find((r) => r.id === "style");
  return {
    overall: Math.round(overall * 10) / 10,
    verdict: verdict(overall),
    words: countWords(text),
    mode: opts.mode,
    detectors: results.map(({ sentenceScores: _s, sentenceNotes: _n, signals: _g, tells: _t, ...r }) => ({
      ...r,
      score: typeof r.score === "number" ? Math.round(r.score * 1000) / 1000 : undefined,
    })),
    sentences: views,
    signals: style?.signals ?? [],
    tells: style?.tells ?? [],
  };
}

// The passages most worth rewriting, highest score first.
export function worstSentences(a: Analysis, limit = 12, threshold = 0.5) {
  return a.sentences
    .filter((s) => s.kind !== "heading" && (s.score ?? 0) >= threshold)
    .sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
    .slice(0, limit);
}
