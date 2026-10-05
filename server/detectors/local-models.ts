// Open-source AI-text classifiers run locally through transformers.js (ONNX on CPU).
// Weights download from Hugging Face on first use and are cached under .cache/models.

import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type Tensor,
} from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import { documentChunks, slidingWindows, type Chunk } from "../text.ts";
import type { Detection, Detector } from "./types.ts";

env.cacheDir = config.modelCacheDir;

interface Spec {
  id: string;
  name: string;
  repo: string;
  weight: number;
  // Turns class probabilities into a 0-1 "how AI" score.
  score: (probs: number[]) => number;
}

const SPECS: Spec[] = [
  // Pangram's EditLens (ICLR 2026), RoBERTa-large trained on Claude Sonnet 4, GPT-4.1 and Gemini 2.5
  // output, including AI-edited human text. Four buckets from human to fully AI; the score is their
  // expected value, as in the paper. Licensed CC BY-NC-SA 4.0: non-commercial use only.
  // Community ONNX conversion of pangram/editlens_roberta-large (weights byte-identical upstream).
  {
    id: "editlens",
    name: "EditLens",
    repo: "CoderBak/editlens_roberta_modelkit",
    weight: 3,
    score: (p) => p.reduce((a, v, i) => a + v * (i / (p.length - 1)), 0),
  },
  // RoBERTa-base trained on RAID (incl. paraphrase/adversarial attacks); 99.3% AUROC on the RAID
  // leaderboard, but RAID's generators are 2023-era, so it misses current models' writing.
  { id: "tmr", name: "TMR RoBERTa", repo: "onnx-community/tmr-ai-text-detector-ONNX", weight: 1.5, score: (p) => p[1] },
  // Small E5 encoder with a LoRA head. Noisy on human text; off by default.
  { id: "e5", name: "E5 LoRA", repo: "onnx-community/e5-small-lora-ai-generated-detector-ONNX", weight: 1, score: (p) => p[1] },
];

export type ModelStatus = "idle" | "loading" | "ready" | "error";

class LocalClassifier {
  status: ModelStatus = "idle";
  error?: string;
  private loading?: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }>;
  private queue: Promise<unknown> = Promise.resolve();
  readonly spec: Spec;

  constructor(spec: Spec) {
    this.spec = spec;
  }

  load() {
    this.loading ??= (async () => {
      this.status = "loading";
      if (!fs.existsSync(path.join(config.modelCacheDir, this.spec.repo))) {
        console.log(`[local] downloading ${this.spec.name} from Hugging Face (first run only; can take a few minutes)…`);
      }
      try {
        const [tokenizer, model] = await Promise.all([
          AutoTokenizer.from_pretrained(this.spec.repo),
          AutoModelForSequenceClassification.from_pretrained(this.spec.repo, { dtype: "fp32" }),
        ]);
        this.status = "ready";
        return { tokenizer, model };
      } catch (err) {
        this.status = "error";
        this.error = (err as Error).message;
        this.loading = undefined; // allow a retry on the next request
        throw err;
      }
    })();
    return this.loading;
  }

  // Probability that each text is AI-generated. Runs are serialized per model.
  async classify(texts: string[], batchSize = 8): Promise<number[]> {
    const { tokenizer, model } = await this.load();
    const run = this.queue.then(async () => {
      const out: number[] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const inputs = tokenizer(batch, { padding: true, truncation: true, max_length: 512 });
        const { logits } = (await model(inputs)) as { logits: Tensor };
        const [rows, cols] = logits.dims as [number, number];
        const data = logits.data as Float32Array;
        for (let r = 0; r < rows; r++) {
          const row = Array.from(data.subarray(r * cols, (r + 1) * cols));
          const max = Math.max(...row);
          const exps = row.map((v) => Math.exp(v - max));
          const total = exps.reduce((a, b) => a + b, 0);
          out.push(this.spec.score(exps.map((e) => e / total)));
        }
      }
      return out;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

export const classifiers = SPECS.filter((s) => config.localModels.includes(s.id)).map((spec) => new LocalClassifier(spec));

export function warmUp() {
  for (const c of classifiers) c.load().catch((err) => console.warn(`[local] ${c.spec.name} failed to load: ${err.message}`));
}

function toDetector(c: LocalClassifier): Detector {
  return {
    id: c.spec.id,
    name: c.spec.name,
    kind: "local",
    weight: c.spec.weight,
    fast: true,
    enabled: () => c.status !== "error",
    async detect(_text, sentences): Promise<Detection> {
      const docs = documentChunks(sentences);
      const wins = slidingWindows(sentences);
      if (!docs.length) return { score: 0, detail: "no prose to score" };

      const probs = await c.classify([...docs, ...wins].map((ch: Chunk) => ch.text));
      const docProbs = probs.slice(0, docs.length);
      const winProbs = probs.slice(docs.length);

      const totalWords = docs.reduce((a, d) => a + d.words, 0);
      const score = docs.reduce((a, d, i) => a + docProbs[i] * d.words, 0) / totalWords;

      // Short windows are noisy (a 100-word excerpt of a human essay can score 60%), so each
      // sentence's local score is averaged with the score of the larger chunk it belongs to.
      const chunkOf: Record<number, number> = {};
      docs.forEach((d, i) => d.sentences.forEach((id) => (chunkOf[id] = docProbs[i])));
      const sums: Record<number, [number, number]> = {};
      wins.forEach((w, i) => {
        for (const id of w.sentences) {
          const acc = (sums[id] ??= [0, 0]);
          acc[0] += winProbs[i];
          acc[1] += 1;
        }
      });
      const sentenceScores = Object.fromEntries(
        Object.entries(sums).map(([id, [t, n]]) => [id, 0.5 * (t / n) + 0.5 * (chunkOf[Number(id)] ?? t / n)]),
      );

      return {
        score,
        sentenceScores,
        detail: `${docs.length} chunk${docs.length === 1 ? "" : "s"}: ${docProbs.map((p) => `${Math.round(p * 100)}%`).join(", ")}`,
      };
    },
  };
}

export const localDetectors: Detector[] = classifiers.map(toDetector);
