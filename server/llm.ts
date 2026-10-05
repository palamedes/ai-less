import fs from "node:fs";
import path from "node:path";
import { apiBackend } from "./backends/api.ts";
import { claudeCodeBackend } from "./backends/claude-code.ts";
import type { Backend } from "./backends/types.ts";
import { describeClaudeError } from "./claude.ts";
import { config } from "./config.ts";

function onPath(bin: string) {
  if (bin.includes("/")) return fs.existsSync(bin);
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const backend: Backend =
  config.backend === "api" || (config.backend === "auto" && !onPath(config.claudeBin)) ? apiBackend : claudeCodeBackend;

export const llm = () => backend;

export interface LlmStatus {
  ok: boolean;
  checked: boolean;
  backend: Backend["id"];
  label: string;
  model: string;
  error?: string;
}

export const llmStatus: LlmStatus = {
  ok: false,
  checked: false,
  backend: backend.id,
  label: backend.id === "api" ? "Claude API" : "Claude Code",
  model: config.rewriteModel,
};

export async function probeLlm(): Promise<LlmStatus> {
  try {
    const label = await backend.probe();
    Object.assign(llmStatus, { ok: true, checked: true, label, error: undefined });
  } catch (err) {
    Object.assign(llmStatus, { ok: false, checked: true, error: describeClaudeError(err) });
  }
  return llmStatus;
}
