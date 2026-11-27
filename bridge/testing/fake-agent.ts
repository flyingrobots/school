// Fake agents for the bridge's tests: small POSIX shell scripts, written per test, that print
// what a real agent CLI prints and contact no model. The streaming one prints the lines of Claude
// Code's `--output-format stream-json --include-partial-messages --verbose`, in the shapes
// Claude Code 2.1.323 prints (`stream_event` lines wrapping the API's `content_block_delta`
// events, then one `assistant` line and one `result` line with `usage`).
//
// Every script is run as `<script> <gate folder> {prompt}`: a `gate` step waits until a file of
// that name exists in the gate folder, so a test decides when the agent may go on, and a `mark`
// step creates one, so a test can see how far the agent got. A `tool` step prints the `assistant`
// line Claude Code prints when the model uses a tool; a `sh` step runs a command in the agent's
// working folder, which is how a fake authoring agent edits its draft.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Step =
  | { delta: string } // one text delta, as a stream_event line
  | { thinking: string } // a thinking delta, which is never part of the answer
  | { result: string; usage?: Record<string, number>; isError?: boolean } // the assistant and result lines
  | { line: string } // a raw line on stdout
  | { stderr: string } // a line on stderr
  | { gate: string } // wait until <gate folder>/<name> exists
  | { mark: string } // create <gate folder>/<name>
  | { echoPrompt: true } // the prompt, as one text delta
  | { retry: true } // Claude Code's `api_retry` system line, printed when it starts the request again
  | { messageStart: true } // another `message_start` event, which a retried request begins with
  | { hang: true } // sleep until killed
  | { tool: string; input: Record<string, unknown>; id?: string } // an assistant line holding one tool_use block, its id toolu_<step index> unless given
  | { sh: string } // a shell command, run in the agent's working folder
  | { exit: number };

export const USAGE = { input_tokens: 12, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 };

/** A single-quoted shell word: the text exactly, whatever it holds. */
const quote = (s: string) => `'${s.split("'").join(`'\\''`)}'`;
const out = (o: unknown) => `printf '%s\\n' ${quote(JSON.stringify(o))}`;
const event = (e: unknown) => out({ type: "stream_event", event: e, session_id: "fake", parent_tool_use_id: null, uuid: "fake" });

function shell(step: Step, at: number): string {
  if ("delta" in step) return event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.delta } });
  if ("thinking" in step) return event({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: step.thinking } });
  if ("result" in step) {
    return [
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: step.result }] }, session_id: "fake" }),
      out({ type: "result", subtype: step.isError ? "error_during_execution" : "success", is_error: step.isError === true, result: step.result,
        usage: step.usage ?? USAGE, total_cost_usd: 0.001, session_id: "fake" }),
    ].join("\n");
  }
  if ("retry" in step) return out({ type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: null, error: "unknown", session_id: "fake" });
  if ("messageStart" in step) return event({ type: "message_start", message: { role: "assistant", content: [] } });
  if ("line" in step) return `printf '%s\\n' ${quote(step.line)}`;
  if ("stderr" in step) return `printf '%s\\n' ${quote(step.stderr)} >&2`;
  // A gate whose folder is gone (the test has ended) ends the agent, so none is left looping.
  if ("gate" in step) return `while [ ! -e "$1/${step.gate}" ]; do [ -d "$1" ] || exit 1; sleep 0.01; done`;
  if ("mark" in step) return `: > "$1/${step.mark}"`;
  if ("echoPrompt" in step) {
    // The prompt is written back as one delta; the tests' prompts hold no character JSON escapes.
    return `printf '%s%s%s\\n' ${quote('{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"')} "$2" ${quote('"}}}')}`;
  }
  if ("hang" in step) return "sleep 600 & wait";
  if ("tool" in step) {
    const block = { type: "tool_use", id: step.id ?? `toolu_${at}`, name: step.tool, input: step.input };
    return out({ type: "assistant", message: { role: "assistant", content: [block] }, session_id: "fake", parent_tool_use_id: null });
  }
  if ("sh" in step) return step.sh;
  return `exit ${step.exit}`;
}

/** Write an executable fake agent named `name` into `dir` and return its path. */
export function fakeAgent(dir: string, name: string, steps: Step[]): string {
  const path = join(dir, name);
  const start = [
    out({ type: "system", subtype: "init", session_id: "fake", tools: [], model: "claude-sonnet-5-5" }),
    event({ type: "message_start", message: { role: "assistant", content: [] } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ];
  writeFileSync(path, ["#!/bin/sh", ...start, ...steps.map((s, at) => shell(s, at))].join("\n") + "\n");
  chmodSync(path, 0o755);
  return path;
}

/** A fake agent that prints `body` as plain text, for the `text` output kind. */
export function plainAgent(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
