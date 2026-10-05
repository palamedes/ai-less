// Runs prompts through the locally installed Claude Code CLI in print mode, so they
// count against your Claude plan instead of prepaid API credits.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import { PipelineError } from "../claude.ts";
import { config } from "../config.ts";
import type { Backend, CallOptions, Usage } from "./types.ts";

// A neutral working directory, so no project's CLAUDE.md or settings come along.
const WORK_DIR = path.join(os.tmpdir(), "ai-less-claude-code");

// Variables that would make the CLI bill an API key instead of the plan login,
// or make it think it's running nested inside another Claude Code session.
const STRIP = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

function childEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000" };
  for (const key of STRIP) delete env[key];
  return env;
}

// Plain model call: our system prompt instead of Claude Code's, no tools, no MCP
// servers, none of the user's hooks/plugins/CLAUDE.md, and nothing saved to session history.
function baseArgs({ system, model, effort }: CallOptions) {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--system-prompt", system,
    "--tools", "",
    "--model", model,
    "--effort", effort,
    "--no-session-persistence",
    "--safe-mode",
    "--strict-mcp-config",
  ];
}

interface ResultMessage {
  type: "result";
  subtype: string;
  is_error: boolean;
  result?: string;
  structured_output?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

function run(args: string[], stdin: string, signal: AbortSignal | undefined, onMessage?: (msg: any) => void) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  return new Promise<ResultMessage>((resolve, reject) => {
    const child = spawn(config.claudeBin, args, { cwd: WORK_DIR, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let result: ResultMessage | null = null;
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (err) => reject(new PipelineError(`Couldn't start Claude Code (${config.claudeBin}): ${err.message}`)));
    child.stderr.on("data", (d) => (stderr += d));
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "result") result = msg;
      onMessage?.(msg);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(Object.assign(new Error("Cancelled."), { name: "AbortError" }));
      if (!result) {
        const tail = stderr.trim().split("\n").slice(-3).join(" ");
        return reject(new PipelineError(`Claude Code exited without an answer (exit ${code}). ${tail}`.trim()));
      }
      if (result.is_error || result.subtype !== "success") {
        return reject(new PipelineError(`Claude Code: ${result.result || result.subtype}`));
      }
      resolve(result);
    });
    child.stdin.on("error", () => {}); // the process may exit before reading everything
    child.stdin.end(stdin);
  });
}

const toUsage = (u: ResultMessage["usage"]): Usage => ({
  input: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
  output: u?.output_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
});

export const claudeCodeBackend: Backend = {
  id: "claude-code",

  async probe() {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.claudeBin, ["auth", "status", "--json"], { cwd: WORK_DIR, env: childEnv() });
      let stdout = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), 20_000);
      child.stdout.on("data", (d) => (stdout += d));
      child.on("error", (err) =>
        reject(new PipelineError(`Claude Code isn't available (${err.message}). Install it, or set AI_LESS_BACKEND=api.`)),
      );
      child.on("close", () => {
        clearTimeout(timer);
        resolve(stdout);
      });
    });
    let status: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
    try {
      status = JSON.parse(out);
    } catch {
      throw new PipelineError("Couldn't read `claude auth status`. Is Claude Code up to date?");
    }
    if (!status.loggedIn) {
      throw new PipelineError("Claude Code isn't logged in. Run `claude auth login` with your Claude account, then reload.");
    }
    if (status.authMethod === "claude.ai") {
      const plan = status.subscriptionType ? `${status.subscriptionType[0].toUpperCase()}${status.subscriptionType.slice(1)} plan` : "your plan";
      return `Claude · ${plan}`;
    }
    return `Claude Code (${status.authMethod ?? "signed in"})`;
  },

  async stream(opts) {
    let streamed = "";
    const result = await run(
      [...baseArgs(opts), "--include-partial-messages"],
      opts.prompt,
      opts.signal,
      (msg) => {
        const delta = msg.type === "stream_event" && msg.event?.type === "content_block_delta" ? msg.event.delta : null;
        if (delta?.type === "text_delta" && delta.text) {
          streamed += delta.text;
          opts.onText(delta.text);
        }
      },
    );
    return { text: result.result ?? streamed, usage: toUsage(result.usage) };
  },

  async json(opts) {
    const { $schema: _, ...schema } = z.toJSONSchema(opts.schema) as Record<string, unknown>;
    const result = await run([...baseArgs(opts), "--json-schema", JSON.stringify(schema)], opts.prompt, opts.signal);
    let raw = result.structured_output;
    if (raw === undefined && result.result) {
      try {
        raw = JSON.parse(result.result);
      } catch {}
    }
    const parsed = opts.schema.safeParse(raw);
    if (!parsed.success) throw new PipelineError("Claude Code returned a result in an unexpected shape.");
    return { data: parsed.data, usage: toUsage(result.usage) };
  },
};
