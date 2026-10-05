# ai-less

Paste an article and get a score for how AI-generated it reads. The tool highlights the sentences that give it away. One button then rewrites it to read human, keeping what it says, how it flows, and the author's voice.

It runs locally: a small Node server plus a single-page UI in your browser.

## Quick start

```sh
npm install
ant auth login            # or put ANTHROPIC_API_KEY in .env (see .env.example)
npm start                 # http://127.0.0.1:5177
```

Requires Node 23.6 or newer, which runs the TypeScript directly with no build step. On first launch it downloads a ~500 MB detector model from Hugging Face into `.cache/models/`.

Scoring works without Claude. Rewriting needs it.

## How scoring works

Several detectors run in parallel. Their scores are combined as a weighted average, both for the whole document and per sentence for the heatmap.

| Detector | Where it runs | Weight | Notes |
|---|---|---|---|
| **TMR RoBERTa** | local (ONNX, CPU) | 2.5 | RoBERTa-base trained on the [RAID](https://raid-bench.xyz) benchmark, including its paraphrase and adversarial attacks. 99.3% AUROC on the RAID leaderboard. |
| **Style tells** | local | 1.5 | Stylometric heuristics: stock vocabulary, sentence-length variance ("burstiness"), "not just X, but Y" constructions, trailing "-ing" clauses, transition openers, lists of three, paragraph uniformity, em-dashes, wrap-up endings, Title Case headings. This is the detector that can say *why* a passage reads as AI. |
| **Claude's read** | Claude API | 1 | A second opinion that flags specific sentences with reasons. LLMs are weak at scoring AI text, so it carries a low weight. It can be toggled off in the UI. |
| **Sapling / GPTZero / Winston / Originality.ai** | their APIs | 3 each | Optional. Each one turns on when its key is in `.env`. These are the detectors people actually get flagged by. Sapling has a free tier. |

Calibration on the samples used during development:

| Text | TMR | Style | Combined |
|---|---|---|---|
| Paul Graham essays (2 excerpts) | 2–3% | 8–11% | 5% |
| Joel Spolsky, *The Joel Test* | 4% | 20% | 10% |
| Jane Austen | 4% | 3% | 3% |
| Wikipedia, *Sourdough* | 97% | 6% | 63% |
| ChatGPT-style marketing post | 99% | 98% | 98% |
| Claude-style how-to article | 97% | 94% | 96% |
| …that article rewritten using the guide in `server/prompts.ts` | 3% | 5% | 4% |

Encyclopedic prose like Wikipedia is a known false positive for most AI detectors, and TMR is no exception. Treat every score as an estimate. Detectors disagree, and no single one is authoritative.

## How the rewrite works

1. The original is scored with every enabled detector.
2. Claude rewrites the full article. The prompt is an editing guide (`server/prompts.ts`) that covers what detectors key on and what must survive the edit: every claim, number, quote, and link; point of view; register; structure. It also gets the detector findings: the worst sentences, the stock phrases found, and which style signals are off.
3. The draft is re-scored with the fast local detectors. If it's still above your target, a revision pass goes back with the sentences that still flag and asks for structural changes there, not just word swaps.
4. Steps 2–3 repeat up to *Max passes*. The best-scoring draft wins.
5. A meaning check compares the result against the original. It lists anything dropped, added, changed, or any drift in voice. The final draft is then scored with the full detector set.

The rewrite streams into the page as it's written. **Intensity** controls how far it goes:

- **Light:** fix the tells, keep most sentences.
- **Balanced:** rewrite sentence by sentence, keep the paragraph structure.
- **Bold:** rebuild the prose from the ideas up.

**Voice notes** let you add guidance such as "casual, first person, keep the jokes".

The prompt rules out cheap detector tricks like homoglyphs, invisible characters, and deliberate typos. They make the text worse, and the better detectors already look for them.

## Configuration

Everything is optional. See [`.env.example`](.env.example) for all settings:

- the rewrite and judge models and their effort levels (default `claude-opus-5-5`)
- which local models to load
- commercial detector API keys
- port and host

## Layout

```
server/
  index.ts              HTTP API (Hono): /api/status, /api/analyze, /api/humanize (SSE)
  analyze.ts            runs detectors in parallel, combines scores
  humanize.ts           rewrite → score → revise loop, meaning check
  prompts.ts            the editing guide and per-pass prompts
  claude.ts             Anthropic client, credential probe, refusal fallback
  text.ts               sentence segmentation with offsets, chunking for classifiers
  detectors/
    heuristics.ts       style tells
    local-models.ts     TMR / E5 via transformers.js
    claude-judge.ts     Claude's read (structured output)
    external.ts         Sapling, GPTZero, Winston, Originality.ai
public/                 the UI (plain HTML/CSS/JS, no build)
```

`npm run typecheck` type-checks the server.
