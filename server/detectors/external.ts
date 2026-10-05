// Commercial detectors, used only when their API key is set in .env. These are
// the ones people actually get flagged by, so when present they dominate the score.

import { config } from "../config.ts";
import type { Sentence } from "../text.ts";
import { clamp01, locate, spansToSentences, type Detection, type Detector } from "./types.ts";

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(90_000);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 240)}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON response: ${raw.slice(0, 240)}`);
  }
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const shape = (o: unknown) => (o && typeof o === "object" ? Object.keys(o).join(", ") : typeof o);

function fromSentenceList(text: string, sentences: Sentence[], items: { text: string; score: number }[]) {
  return items.length ? spansToSentences(sentences, locate(text, items)) : undefined;
}

const MIN_CHARS = 300;
function requireLength(text: string, name: string) {
  if (text.length < MIN_CHARS) throw new Error(`${name} needs at least ${MIN_CHARS} characters`);
}

// https://sapling.ai/docs/api/detector — free tier: 50k chars/day.
const sapling: Detector = {
  id: "sapling",
  name: "Sapling",
  kind: "external",
  weight: 3,
  fast: false,
  enabled: () => Boolean(config.keys.sapling),
  async detect(text, sentences, signal): Promise<Detection> {
    requireLength(text, "Sapling");
    const json = await post("https://api.sapling.ai/api/v1/aidetect", {}, { key: config.keys.sapling, text, sent_scores: true }, signal);
    const score = num(json.score);
    if (score === undefined) throw new Error(`Unexpected response shape (keys: ${shape(json)})`);
    const items: { text: string; score: number }[] = (json.sentence_scores ?? [])
      .filter((s: any) => typeof s?.sentence === "string" && num(s.score) !== undefined)
      .map((s: any) => ({ text: s.sentence, score: s.score }));
    return { score: clamp01(score), sentenceScores: fromSentenceList(text, sentences, items) };
  },
};

// https://gptzero.me/docs — paid API.
const gptzero: Detector = {
  id: "gptzero",
  name: "GPTZero",
  kind: "external",
  weight: 3,
  fast: false,
  enabled: () => Boolean(config.keys.gptzero),
  async detect(text, sentences, signal): Promise<Detection> {
    const json = await post("https://api.gptzero.me/v2/predict/text", { "x-api-key": config.keys.gptzero! }, { document: text }, signal);
    const doc = json.documents?.[0] ?? json;
    const score = num(doc.class_probabilities?.ai) ?? num(doc.completely_generated_prob) ?? num(doc.average_generated_prob);
    if (score === undefined) throw new Error(`Unexpected response shape (keys: ${shape(doc)})`);
    const items: { text: string; score: number }[] = (doc.sentences ?? [])
      .filter((s: any) => typeof s?.sentence === "string" && num(s.generated_prob) !== undefined)
      .map((s: any) => ({ text: s.sentence, score: s.generated_prob }));
    const label = typeof doc.predicted_class === "string" ? doc.predicted_class : doc.document_classification;
    return { score: clamp01(score), sentenceScores: fromSentenceList(text, sentences, items), detail: label ? `classified as ${label}` : undefined };
  },
};

// https://docs.gowinston.ai — note Winston's score is a HUMAN score (0-100), so it's inverted.
const winston: Detector = {
  id: "winston",
  name: "Winston AI",
  kind: "external",
  weight: 3,
  fast: false,
  enabled: () => Boolean(config.keys.winston),
  async detect(text, sentences, signal): Promise<Detection> {
    requireLength(text, "Winston");
    const json = await post(
      "https://api.gowinston.ai/v2/ai-content-detection",
      { Authorization: `Bearer ${config.keys.winston}` },
      { text, sentences: true, language: "auto" },
      signal,
    );
    const human = num(json.score);
    if (human === undefined) throw new Error(`Unexpected response shape (keys: ${shape(json)})`);
    const items: { text: string; score: number }[] = (json.sentences ?? [])
      .filter((s: any) => typeof s?.text === "string" && num(s.score) !== undefined)
      .map((s: any) => ({ text: s.text, score: 1 - s.score / 100 }));
    const attacks = Object.entries(json.attack_detected ?? {}).filter(([, v]) => v === true).map(([k]) => k);
    return {
      score: clamp01(1 - human / 100),
      sentenceScores: fromSentenceList(text, sentences, items),
      detail: attacks.length ? `attack flags: ${attacks.join(", ")}` : undefined,
    };
  },
};

// https://docs.originality.ai — response nesting isn't fully documented, so parsing is defensive.
const originality: Detector = {
  id: "originality",
  name: "Originality.ai",
  kind: "external",
  weight: 3,
  fast: false,
  enabled: () => Boolean(config.keys.originality),
  async detect(text, sentences, signal): Promise<Detection> {
    const json = await post(
      "https://api.originality.ai/api/v3/scan",
      { "X-OAI-API-KEY": config.keys.originality! },
      {
        title: "ai-less check",
        content: text,
        check_ai: true,
        check_plagiarism: false,
        check_facts: false,
        check_readability: false,
        check_grammar: false,
        storeScan: false,
        aiModelVersion: "lite",
      },
      signal,
    );
    const ai = json.ai ?? json;
    const score =
      num(ai.confidence?.AI) ?? num(ai.confidence?.ai) ?? num(ai.score?.ai) ?? num(ai.ai) ?? num(json.score?.ai);
    if (score === undefined) throw new Error(`Unexpected response shape (keys: ${shape(json)}; ai: ${shape(json.ai)})`);
    const blocks: any[] = ai.blocks ?? json.blocks ?? [];
    const items = blocks
      .filter((b) => typeof b?.text === "string" && num(b.result?.fake) !== undefined)
      .map((b) => ({ text: b.text as string, score: b.result.fake as number }));
    return { score: clamp01(score > 1 ? score / 100 : score), sentenceScores: fromSentenceList(text, sentences, items) };
  },
};

export const externalDetectors: Detector[] = [sapling, gptzero, winston, originality];
