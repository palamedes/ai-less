# ai-less

Paste an article and get a score for how AI-generated it reads. The tool highlights the sentences that give it away. One button then rewrites it to read human, keeping what it says, how it flows, and the author's voice.

It runs locally: a small Node server plus a single-page UI in your browser.

## Quick start

```sh
./ai-less                 # serves http://127.0.0.1:5177 and opens it in your browser
```

```sh
./ai-less --port 9000 --no-browser
./ai-less --help
ln -s "$PWD/ai-less" ~/.local/bin/ai-less    # run it from anywhere
```

The first run installs the npm dependencies, and the launcher reinstalls them whenever `package-lock.json` changes. The detector models (~2 GB) download from Hugging Face into `.cache/models/` on first launch, which takes a few minutes. If ai-less is already running, `./ai-less` just opens the page again. Ctrl+C stops it.

Requires Node 23.6 or newer, which runs the TypeScript directly with no build step. For development, `npm run dev` restarts the server on file changes without opening a browser.

Scoring works without Claude. Rewriting needs it, and there are two ways to reach it:

- **Claude Code (default when the `claude` command is installed).** The calls run through your local Claude Code login, so they count against your Claude plan (Pro/Max) and need no API credits. Each call is isolated: ai-less's own system prompt, no tools, no MCP servers, none of your hooks, plugins or CLAUDE.md, and nothing saved to your session history. API-key environment variables are stripped so it can't fall back to billing the API.
- **Anthropic API.** Set `AI_LESS_BACKEND=api` and run `ant auth login` (or set `ANTHROPIC_API_KEY`). This is billed to the API account's prepaid credits, which are separate from a Claude plan.

The status pill at the top of the page shows which route is in use.

## How scoring works

Several detectors run in parallel. Detectors fail by missing things more than by inventing them: on current models' writing, some see nothing while others are certain it's AI. So the overall score leans on the strongest signal, at **70% of the highest detector score plus 30% of the weighted average**. Detectors marked noisy (TMR, E5) count toward the average but can't lead. The heatmap uses the weighted average per sentence.

| Detector | Where it runs | Weight | Notes |
|---|---|---|---|
| **EditLens** | local (ONNX, CPU) | 3 | Pangram's open research model ([ICLR 2026](https://arxiv.org/abs/2510.03154)): RoBERTa-large trained on Claude Sonnet 4, GPT-4.1 and Gemini 2.5 output, including AI-edited human text. ~1.4 GB download. **Licensed CC BY-NC-SA 4.0, non-commercial use only.** Drop it with `AI_LESS_LOCAL_MODELS=off` if that doesn't fit your use. |
| **TMR RoBERTa** | local (ONNX, CPU) | 1.5, noisy | Off by default (`AI_LESS_LOCAL_MODELS=editlens,tmr` turns it on). RoBERTa-base trained on the [RAID](https://raid-bench.xyz) benchmark (99.3% AUROC there). RAID's generators are 2023-era, so it misses current models' writing and flags encyclopedic prose. |
| **Style tells** | local | 1.5 | Stylometric heuristics in two families, scored separately with the stronger one counting. *Classic:* stock vocabulary, uniform rhythm, "not just X, but Y", trailing "-ing" clauses, transition openers, lists of three, uniform paragraphs, wrap-up endings. *Punchy* (current models asked to sound human): runs of sentences with the same opener, one-line mic-drop paragraphs, bolded punchlines, "This isn't X. This is Y." reversals, "And yes, I know…" concessions. This is the detector that can say *why* a passage reads as AI. |
| **Claude's read** | Claude | 2 | A second opinion that knows both styles and flags specific sentences with reasons. Runs on every rewrite pass; toggle it off in the UI. |
| **Sapling / GPTZero / Winston / Originality.ai** | their APIs | 3 each | Optional. Each one turns on when its key is in `.env`. These are the detectors people actually get flagged by. Sapling has a free tier. |

Calibration on the samples used during development:

| Text | EditLens | Style | Claude | TMR (off) | Overall |
|---|---|---|---|---|---|
| Paul Graham essays (2 excerpts) | 9–10% | 8–11% | 2–4% | 2% | 9–10% |
| Joel Spolsky, *The Joel Test* | 17% | 28% | 3% | 4% | 24% |
| Jane Austen | 4% | 3% | 1% | 4% | 4% |
| Wikipedia, *Sourdough* | 3% | 6% | 3% | 97% | 5% |
| ChatGPT-style marketing post | 100% | 98% | 97% | 99% | 100% |
| Claude-style how-to article | 66% | 94% | 88% | 97% | 89% |
| An opinionated op-ed written by a current frontier model (Pangram and GPTZero: 100% AI) | 26% | 78% | 90% | 5% | 80% |
| …that op-ed after an ai-less rewrite | 13% | 4% | 85% | 3% | 69% |

The op-ed rows are the honest limit of local detection. Pangram's production detector is far stronger than its open research model, and on current models' "punchy" writing no free local classifier comes close to it. The style tells and Claude's read are what catch it here. Treat every score as an estimate, and check final drafts with the detector you actually care about.

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
  llm.ts                picks the Claude backend, connection status
  backends/
    claude-code.ts      Claude Code CLI in print mode (your plan)
    api.ts              Anthropic API via the SDK (API credits)
  claude.ts             Anthropic client, error messages, refusal fallback
  text.ts               sentence segmentation with offsets, chunking for classifiers
  detectors/
    heuristics.ts       style tells
    local-models.ts     TMR / E5 via transformers.js
    claude-judge.ts     Claude's read (structured output)
    external.ts         Sapling, GPTZero, Winston, Originality.ai
public/                 the UI (plain HTML/CSS/JS, no build)
```

`npm run typecheck` type-checks the server.
