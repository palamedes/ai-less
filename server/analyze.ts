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
  lead?: { name: string; score: number }; // the detector that most drove the overall score
  words: number;
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
  const base = { id: d.id, name: d.name, kind: d.kind, weight: d.weight, noisy: d.noisy };
  try {
    const result: Detection = await d.detect(text, sentences, signal);
    return { ...base, ...result, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    const error = d.kind === "llm" ? describeClaudeError(err) : (err as Error).message;
    return { ...base, error, ms: Math.round(performance.now() - t0) };
  }
}

// Fast mode skips slow/paid detectors (commercial APIs); it's what the rewrite loop uses per pass.
export function activeDetectors(mode: "full" | "fast", judge: boolean) {
  return detectors.filter((d) => d.enabled() && (mode === "full" || d.fast) && (d.id !== "claude" || judge));
}

export async function analyze(text: string, opts: AnalyzeOptions): Promise<Analysis> {
  const sentences = splitSentences(text);
  const active = activeDetectors(opts.mode, opts.judge ?? false);
  const results = await Promise.all(active.map((d) => run(d, text, sentences, opts.signal)));
  const ok = results.filter((r) => r.error === undefined && typeof r.score === "number");

  // Detectors fail by missing things, not by inventing them: on current models' writing some
  // see nothing while others are confident it's AI. A plain average lets the blind ones outvote
  // the ones that caught it, so the overall score leans on the strongest signal (tempered by the
  // average). On the development samples this keeps human text at 4-24% and puts AI text,
  // including rewritten AI text, at 66-100%.
  const weightSum = ok.reduce((a, r) => a + r.weight, 0);
  const mean = weightSum ? ok.reduce((a, r) => a + r.score! * r.weight, 0) / weightSum : 0;
  const leaders = ok.filter((r) => !r.noisy);
  const lead = (leaders.length ? leaders : ok).reduce<DetectorResult | undefined>((a, r) => (!a || r.score! > a.score! ? r : a), undefined);
  const overall = lead ? 100 * (0.7 * lead.score! + 0.3 * mean) : 0;

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
    lead: lead ? { name: lead.name, score: Math.round(lead.score! * 1000) / 10 } : undefined,
    words: countWords(text),
    detectors: results.map(({ sentenceScores: _s, sentenceNotes: _n, signals: _g, tells: _t, ...r }) => ({
      ...r,
      score: typeof r.score === "number" ? Math.round(r.score * 1000) / 1000 : undefined,
    })),
    sentences: views,
    signals: style?.signals ?? [],
    tells: style?.tells ?? [],
  };
}

// Analyses are cached by the exact set of detectors that ran, so "Analyze" followed by "De-AI it",
// and a final full score of a draft the loop already scored, don't redo identical work. Results
// with a failed detector aren't cached, so that detector gets another try next time.
const cache = new Map<string, Analysis>();
const cacheKey = (text: string, mode: "full" | "fast", judge: boolean) =>
  `${activeDetectors(mode, judge).map((d) => d.id).join(",")}\n${text}`;

export function cachedAnalysis(text: string, mode: "full" | "fast", judge: boolean) {
  return cache.get(cacheKey(text, mode, judge));
}

export async function cachedAnalyze(text: string, mode: "full" | "fast", judge: boolean, signal?: AbortSignal) {
  const key = cacheKey(text, mode, judge);
  const hit = cache.get(key);
  if (hit) return hit;
  const result = await analyze(text, { mode, judge, signal });
  if (result.detectors.every((d) => !d.error)) {
    cache.set(key, result);
    if (cache.size > 40) cache.delete(cache.keys().next().value!);
  }
  return result;
}

// The passages most worth rewriting, highest score first.
export function worstSentences(a: Analysis, limit = 12, threshold = 0.5) {
  return a.sentences
    .filter((s) => s.kind !== "heading" && (s.score ?? 0) >= threshold)
    .sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
    .slice(0, limit);
}
