import { spawn } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { describeClaudeError, PipelineError } from "./claude.ts";
import { config, ROOT } from "./config.ts";
import { externalDetectors } from "./detectors/external.ts";
import { classifiers, warmUp } from "./detectors/local-models.ts";
import { cachedAnalyze } from "./analyze.ts";
import { checkFidelity, humanize } from "./humanize.ts";
import { llmStatus, probeLlm } from "./llm.ts";

const USAGE = `Usage: ai-less [--port N] [--host ADDR] [--no-browser]

Score how AI-generated an article reads, then rewrite it to read human.

  --port N       port for the local web page (default: ${config.port})
  --host ADDR    address to listen on (default: ${config.host}); 0.0.0.0 lets other devices on your network in
  --no-browser   don't open the page in a browser
  -h, --help     show this help`;

let cli;
try {
  cli = parseArgs({
    options: {
      port: { type: "string" },
      host: { type: "string" },
      "no-browser": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  }).values;
} catch (err) {
  console.error(`${(err as Error).message}\n\n${USAGE}`);
  process.exit(1);
}
if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}
if (cli.port !== undefined) {
  config.port = Number(cli.port);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    console.error(`--port must be a number between 1 and 65535, not "${cli.port}"`);
    process.exit(1);
  }
}
if (cli.host) config.host = cli.host;

const MAX_CHARS = 60_000;
// Not trimmed: sentence offsets returned to the browser index into the exact text it sent.
const Text = z
  .string()
  .max(MAX_CHARS, `Keep it under ${MAX_CHARS.toLocaleString()} characters.`)
  .refine((s) => s.trim().length > 0, "Paste some text first.");

const AnalyzeBody = z.object({ text: Text, judge: z.boolean().default(true) });
const HumanizeBody = z.object({
  text: Text,
  options: z
    .object({
      intensity: z.enum(["light", "balanced", "bold"]).default("balanced"),
      voiceNotes: z.string().max(2000).optional(),
      keepFormatting: z.boolean().default(true),
      targetScore: z.number().min(0).max(100).default(20),
      maxPasses: z.number().int().min(1).max(5).default(3),
      judge: z.boolean().default(true),
    })
    .prefault({}),
});

const app = new Hono();

let lastProbe = 0;
async function ensureClaude() {
  if (!llmStatus.ok && Date.now() - lastProbe > 5_000) {
    lastProbe = Date.now();
    await probeLlm();
  }
  return llmStatus;
}

app.get("/api/status", async (c) => {
  await ensureClaude();
  return c.json({
    claude: llmStatus,
    local: classifiers.map((m) => ({ id: m.spec.id, name: m.spec.name, status: m.status, error: m.error })),
    external: externalDetectors.map((d) => ({ id: d.id, name: d.name, configured: d.enabled() })),
  });
});

app.post("/api/analyze", async (c) => {
  const parsed = AnalyzeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad request" }, 400);
  await ensureClaude();
  const { text, judge } = parsed.data;
  return c.json(await cachedAnalyze(text, "full", judge && llmStatus.ok, c.req.raw.signal));
});

// Meaning check for any draft on demand (the rewrite loop only checks the best one).
const FidelityBody = z.object({ original: Text, rewrite: Text });
app.post("/api/fidelity", async (c) => {
  const parsed = FidelityBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad request" }, 400);
  const status = await ensureClaude();
  if (!status.ok) return c.json({ error: status.error ?? "Claude isn't connected." }, 503);
  try {
    const { fidelity } = await checkFidelity(parsed.data.original, parsed.data.rewrite, c.req.raw.signal);
    return c.json({ fidelity });
  } catch (err) {
    return c.json({ error: describeClaudeError(err) }, 502);
  }
});

app.post("/api/humanize", async (c) => {
  const parsed = HumanizeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad request" }, 400);
  const status = await ensureClaude();
  if (!status.ok) return c.json({ error: status.error ?? "Claude isn't connected." }, 503);

  const { text, options } = parsed.data;
  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    try {
      await humanize(text, options, (e) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }), controller.signal);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("[humanize]", err);
      let message = describeClaudeError(err);
      if (!(err instanceof PipelineError) && !(await probeLlm()).ok) message = llmStatus.error!;
      await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message }) });
    }
  });
});

const publicDir = path.relative(process.cwd(), path.join(ROOT, "public")) || ".";
const diffBundle = path.relative(process.cwd(), path.join(ROOT, "node_modules/diff/dist/diff.min.js"));
app.get("/vendor/diff.min.js", serveStatic({ path: diffBundle }));
app.use("/*", serveStatic({ root: publicDir }));

function openBrowser(url: string) {
  const [cmd, ...args] =
    process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

async function alreadyRunning(url: string) {
  try {
    const res = await fetch(`${url}api/status`, { signal: AbortSignal.timeout(1500) });
    return res.ok && "claude" in ((await res.json()) as object);
  } catch {
    return false;
  }
}

const local = ["127.0.0.1", "localhost"].includes(config.host);
const url = `http://${local ? config.host : "127.0.0.1"}:${config.port}/`;

if (await alreadyRunning(url)) {
  console.log(`ai-less is already running at ${url}`);
  if (!cli["no-browser"]) openBrowser(url);
  process.exit(0);
}

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, () => {
  console.log(`ai-less is running at ${url}\nPress Ctrl+C to stop.`);
  if (!cli["no-browser"]) openBrowser(url);
  warmUp();
  probeLlm().then((s) =>
    console.log(s.ok ? `[claude] ${s.label} via ${s.backend}, ${s.model}` : `[claude] not connected (${s.backend}): ${s.error}`),
  );
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(`Port ${config.port} is already in use. Try another one, e.g. --port ${config.port + 1}`);
  process.exit(1);
});
