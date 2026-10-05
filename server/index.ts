import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { claudeStatus, describeClaudeError, PipelineError, probeClaude } from "./claude.ts";
import { config, ROOT } from "./config.ts";
import { externalDetectors } from "./detectors/external.ts";
import { classifiers, warmUp } from "./detectors/local-models.ts";
import { cachedAnalyze, humanize } from "./humanize.ts";

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
  if (!claudeStatus.ok && Date.now() - lastProbe > 5_000) {
    lastProbe = Date.now();
    await probeClaude();
  }
  return claudeStatus;
}

app.get("/api/status", async (c) => {
  await ensureClaude();
  return c.json({
    claude: claudeStatus,
    local: classifiers.map((m) => ({ id: m.spec.id, name: m.spec.name, status: m.status, error: m.error })),
    external: externalDetectors.map((d) => ({ id: d.id, name: d.name, configured: d.enabled() })),
  });
});

app.post("/api/analyze", async (c) => {
  const parsed = AnalyzeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad request" }, 400);
  await ensureClaude();
  const { text, judge } = parsed.data;
  return c.json(await cachedAnalyze(text, "full", judge && claudeStatus.ok, c.req.raw.signal));
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
      if (!(err instanceof PipelineError) && !(await probeClaude()).ok) message = claudeStatus.error!;
      await stream.writeSSE({ event: "error", data: JSON.stringify({ type: "error", message }) });
    }
  });
});

const publicDir = path.relative(process.cwd(), path.join(ROOT, "public")) || ".";
const diffBundle = path.relative(process.cwd(), path.join(ROOT, "node_modules/diff/dist/diff.min.js"));
app.get("/vendor/diff.min.js", serveStatic({ path: diffBundle }));
app.use("/*", serveStatic({ root: publicDir }));

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, ({ port }) => {
  console.log(`ai-less running at http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${port}`);
});

warmUp();
probeClaude().then((s) => console.log(s.ok ? `[claude] connected (${s.model})` : `[claude] not connected: ${s.error}`));
