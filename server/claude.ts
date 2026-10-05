import Anthropic from "@anthropic-ai/sdk";

// Server-side refusal fallback: if a safety classifier declines a request, the
// API re-runs it on Anthropic's recommended fallback model instead of failing.
export const fallback = () => ({
  betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[],
  fallbacks: "default" as const,
});

let client: Anthropic | null = null;

export function claude(): Anthropic {
  client ??= new Anthropic({ maxRetries: 3 });
  return client;
}

export function resetClaude() {
  client = null;
}

// An error whose message is already fit to show the user.
export class PipelineError extends Error {}

export function describeClaudeError(err: unknown): string {
  if (err instanceof PipelineError) return err.message;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return `Claude rejected the credentials (${err.status}).`;
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude rate limit hit; wait a moment and try again.";
  if (err instanceof Anthropic.APIError) {
    // The API's own explanation, without the raw JSON envelope around it.
    const body = err.error as { error?: { message?: string } } | undefined;
    return `Claude API error ${err.status ?? ""}: ${body?.error?.message ?? err.message}`;
  }
  if (err instanceof Error && err.name === "AbortError") return "Cancelled.";
  return (err as Error)?.message ?? String(err);
}

export function assertNotRefused(message: Anthropic.Beta.BetaMessage) {
  if (message.stop_reason === "refusal") {
    const why = message.stop_details?.explanation ?? message.stop_details?.category ?? "no reason given";
    throw new PipelineError(`Claude declined this request (${why}).`);
  }
}
