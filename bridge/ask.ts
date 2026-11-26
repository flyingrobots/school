// Answering a question (RFC 6 §5.4, flyingrobots/school#226). Not implemented yet.
import type { AskConfig } from "./run.ts";
export type Usage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
};
export type AskAttempt = { agent: string; status: "succeeded" | "failed" | "skipped"; error: string | null; exitCode: number | null; ms: number; deltas: number };
export type AskResult =
  | { status: "succeeded"; agent: string; usage: Usage | null; attempts: AskAttempt[] }
  | { status: "failed"; agent: string | null; error: string; attempts: AskAttempt[] };
export type AskJob = { prompt: string; deadlineMs?: number; signal?: AbortSignal };

export async function runAsk(_cfg: AskConfig, _job: AskJob, _onDelta: (text: string) => void): Promise<AskResult> {
  throw new Error("not implemented");
}
