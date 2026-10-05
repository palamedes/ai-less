// Calls the Anthropic API directly. Billed to the API account's prepaid credits,
// which are separate from a Claude plan.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { assertNotRefused, claude, describeClaudeError, fallback, PipelineError, resetClaude } from "../claude.ts";
import { config } from "../config.ts";
import type { Backend, Usage } from "./types.ts";

const toUsage = (u: Anthropic.Beta.BetaUsage): Usage => ({
  input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens ?? 0,
});

export const apiBackend: Backend = {
  id: "api",

  async probe() {
    // A fresh client picks up a new `ant auth login` or key without restarting.
    resetClaude();
    try {
      await claude().models.retrieve(config.rewriteModel);
      return "Claude API";
    } catch (err) {
      resetClaude();
      throw new PipelineError(`${describeClaudeError(err)} Run \`ant auth login\`, or put ANTHROPIC_API_KEY in .env and restart.`);
    }
  },

  async stream({ system, prompt, model, effort, onText, signal }) {
    const stream = claude().beta.messages.stream(
      {
        ...fallback(),
        model,
        max_tokens: 64000,
        output_config: { effort },
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: prompt }],
      },
      { signal },
    );
    stream.on("text", onText);
    const message = await stream.finalMessage();
    assertNotRefused(message);
    if (message.stop_reason === "max_tokens") throw new PipelineError("The response hit the output limit before finishing.");
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, usage: toUsage(message.usage) };
  },

  async json({ system, prompt, model, effort, schema, signal }) {
    const message = await claude().beta.messages.parse(
      {
        ...fallback(),
        model,
        max_tokens: 16000,
        output_config: { effort, format: betaZodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content: prompt }],
      },
      { signal },
    );
    assertNotRefused(message);
    if (message.parsed_output == null) throw new PipelineError("Claude returned a result in an unexpected shape.");
    return { data: message.parsed_output, usage: toUsage(message.usage) };
  },
};
