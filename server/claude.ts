import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";

// Server-side refusal fallback: if a safety classifier declines a request, the
// API re-runs it on Anthropic's recommended fallback model instead of failing.
export const fallback = () => ({
  betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: "default" as const,
});

export interface ClaudeStatus {
  ok: boolean;
  checked: boolean;
  model: string;
  error?: string;
}

let client: Anthropic | null = null;
export const claudeStatus: ClaudeStatus = { ok: false, checked: false, model: config.rewriteModel };

export function claude(): Anthropic {
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

// An error whose message is already fit to show the user.
export class PipelineError extends Error {}

export function describeClaudeError(err: unknown): string {
  const hint = "Run `ant auth login`, or put ANTHROPIC_API_KEY in .env, then restart.";
  if (err instanceof PipelineError) return err.message;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return `Claude rejected the credentials (${err.status}). ${hint}`;
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude rate limit hit; wait a moment and try again.";
  if (err instanceof Anthropic.APIError) {
    // The API's own explanation, without the raw JSON envelope around it.
    const body = err.error as { error?: { message?: string } } | undefined;
    return `Claude API error ${err.status ?? ""}: ${body?.error?.message ?? err.message}`;
  }
  if (err instanceof Error && err.name === "AbortError") return "Cancelled.";
  // Credential resolution failures (no key, expired login) are thrown before any request is made.
  return `${(err as Error)?.message ?? String(err)} ${hint}`;
}

// Cheap credential check (no tokens spent). Builds a fresh client so a new
// `ant auth login` or key is picked up without restarting.
export async function probeClaude(): Promise<ClaudeStatus> {
  try {
    client = new Anthropic({ maxRetries: 1 });
    await client.models.retrieve(config.rewriteModel);
    client = new Anthropic({ maxRetries: 3 });
    Object.assign(claudeStatus, { ok: true, checked: true, error: undefined });
  } catch (err) {
    client = null;
    Object.assign(claudeStatus, { ok: false, checked: true, error: describeClaudeError(err) });
  }
  return claudeStatus;
}

export function assertNotRefused(message: Anthropic.Beta.BetaMessage) {
  if (message.stop_reason === "refusal") {
    const why = message.stop_details?.explanation ?? message.stop_details?.category ?? "no reason given";
    throw new PipelineError(`Claude declined this request (${why}).`);
  }
}
