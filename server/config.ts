import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

const env = process.env;
const effort = (value: string | undefined, fallback: Effort): Effort =>
  (["low", "medium", "high", "xhigh", "max"] as const).find((e) => e === value) ?? fallback;

export const config = {
  port: Number(env.PORT ?? 5177),
  host: env.HOST ?? "127.0.0.1",

  // Where Claude calls go. "claude-code" runs them through the local Claude Code CLI, so they
  // count against your Claude plan; "api" uses the Anthropic API and its prepaid credits.
  // "auto" picks claude-code whenever the `claude` command is installed.
  backend: (["claude-code", "api"] as const).find((b) => b === env.AI_LESS_BACKEND) ?? "auto",
  claudeBin: env.AI_LESS_CLAUDE_BIN ?? "claude",

  // Claude does the rewriting, the meaning check, and (optionally) a second-opinion read.
  rewriteModel: env.AI_LESS_REWRITE_MODEL ?? "claude-opus-5-5",
  rewriteEffort: effort(env.AI_LESS_REWRITE_EFFORT, "high"),
  judgeModel: env.AI_LESS_JUDGE_MODEL ?? "claude-opus-5-5",
  judgeEffort: effort(env.AI_LESS_JUDGE_EFFORT, "low"),

  // Local classifier models, downloaded from Hugging Face on first run.
  modelCacheDir: env.AI_LESS_MODEL_CACHE ?? path.join(ROOT, ".cache", "models"),
  // Comma-separated ids from server/detectors/local-models.ts, or "off". E5 is noisy on
  // human text (35-85% on human essays in testing), so only TMR is on by default.
  localModels: (env.AI_LESS_LOCAL_MODELS ?? "tmr").split(",").map((s) => s.trim()).filter((s) => s && s !== "off"),

  // Optional commercial detectors. Each one is used only when its key is set.
  keys: {
    sapling: env.SAPLING_API_KEY,
    gptzero: env.GPTZERO_API_KEY,
    winston: env.WINSTON_API_KEY,
    originality: env.ORIGINALITY_API_KEY,
  },
};
