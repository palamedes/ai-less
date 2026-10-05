import type { z } from "zod";
import type { Effort } from "../config.ts";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface CallOptions {
  system: string;
  prompt: string;
  model: string;
  effort: Effort;
  signal?: AbortSignal;
}

// One way of reaching Claude. Everything that talks to a model goes through this,
// so the rest of the app doesn't care whether it's the API or the Claude Code CLI.
export interface Backend {
  id: "claude-code" | "api";
  // Checks the backend is usable without spending tokens. Returns a short label
  // for the UI, or throws an error whose message tells the user what to fix.
  probe(): Promise<string>;
  // Free-form text, delivered to onText as it's generated.
  stream(opts: CallOptions & { onText: (text: string) => void }): Promise<{ text: string; usage: Usage }>;
  // Output constrained to a schema and validated against it.
  json<S extends z.ZodType>(opts: CallOptions & { schema: S }): Promise<{ data: z.infer<S>; usage: Usage }>;
}
