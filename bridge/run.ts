// The agent chain (RFC 1 proposal 4). Each agent is a command template the learner wrote. They
// are tried in order, a hierarchy of fallbacks: an agent that is missing, disabled, fails, times
// out, or returns output that does not match the requested schema hands over to the next one.
// Every attempt is reported, so the server can keep the whole record.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, type Schema } from "./schema.ts";
import { TemplateError, expand, splitCommand, usesPlaceholder } from "./template.ts";

export const OUTPUTS = ["text", "claude-json", "claude-stream-json"] as const;
export type OutputKind = (typeof OUTPUTS)[number];

export type Agent = { name: string; argv: string[]; output: OutputKind; timeoutMs: number; enabled: boolean };
/** The agents that answer a learner's question (RFC 6 §5.4): a list of their own, with their own timeout. */
export type AskConfig = { timeoutMs: number; agents: Agent[] };
/** The agents that draft a course (RFC 9 §5.1): a list of their own, with their own timeout. */
export type AuthorConfig = { timeoutMs: number; agents: Agent[] };
export type BridgeConfig = { timeoutMs: number; agents: Agent[]; ask: AskConfig | null; author: AuthorConfig | null };

const MAX_OUTPUT = 1024 * 1024;
const TAIL = 4000;

export class BridgeConfigError extends Error {}

/** Parse and check a configuration object (the parsed bridge.json). Throws BridgeConfigError. */
export function loadConfig(raw: unknown): BridgeConfig {
  if (typeof raw !== "object" || raw === null) fail("the configuration must be a JSON object");
  const o = raw as Record<string, unknown>;
  const timeoutMs = seconds(o.timeout_seconds, 180, "");
  const agents = agentList(o.agents, timeoutMs, "agents", "agent");
  return { timeoutMs, agents, ask: list(o, "ask", 90), author: list(o, "author", 900) };
}

const fail = (m: string): never => { throw new BridgeConfigError(m); };

/** The `ask` or `author` list, if the file has one: its own timeout (default `fallback` seconds) and agents. */
function list(o: Record<string, unknown>, key: "ask" | "author", fallback: number): AskConfig | null {
  const v = o[key];
  if (v === undefined) return null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`"${key}" must be an object, like { "timeout_seconds": ${fallback}, "agents": [...] }`);
  const l = v as Record<string, unknown>;
  const timeoutMs = seconds(l.timeout_seconds, fallback, `${key}: `);
  return { timeoutMs, agents: agentList(l.agents, timeoutMs, key, `${key} agent`) };
}

/** A timeout in seconds, from 1 to 900, as milliseconds; `fallback` when it is not given. */
function seconds(v: unknown, fallback: number, where: string): number {
  const n = v === undefined ? fallback : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 900) fail(`${where}timeout_seconds must be an integer from 1 to 900`);
  return (n as number) * 1000;
}

/** One list of agents, the grading, ask or author list, each name used once. */
function agentList(list: unknown, timeoutMs: number, where: "agents" | "ask" | "author", what: string): Agent[] {
  const under = `"${where}"`;
  if (!Array.isArray(list) || list.length === 0) fail(`list at least one agent under ${under}`);
  const seen = new Set<string>();
  return (list as unknown[]).map((a, i): Agent => {
    if (typeof a !== "object" || a === null) fail(`${what} ${i + 1} must be an object`);
    const x = a as Record<string, unknown>;
    if (typeof x.name !== "string" || x.name === "") fail(`${what} ${i + 1} needs a "name"`);
    const name = x.name as string;
    if (seen.has(name)) fail(`${what} "${name}" is listed twice`);
    seen.add(name);
    if (typeof x.command !== "string") fail(`${what} "${name}" needs a "command", like: claude -p {prompt}`);
    let argv: string[] = [];
    try {
      argv = splitCommand(x.command as string);
    } catch (e) {
      fail(`${what} "${name}": ${e instanceof TemplateError ? e.message : String(e)}`);
    }
    const output = (x.output ?? "text") as OutputKind;
    if (!OUTPUTS.includes(output)) fail(`${what} "${name}": output must be one of ${OUTPUTS.join(", ")}`);
    const ownTimeout = x.timeout_seconds === undefined ? timeoutMs : seconds(x.timeout_seconds, 0, `${what} "${name}": `);
    return { name, argv, output, timeoutMs: ownTimeout, enabled: x.enabled !== false };
  });
}

export type Attempt = {
  agent: string;
  status: "succeeded" | "failed" | "skipped";
  error?: string;
  exitCode?: number | null;
  ms: number;
  stdout?: string;
  stderr?: string;
};
export type ChainResult =
  | { status: "succeeded"; agent: string; output: unknown; attempts: Attempt[] }
  | { status: "failed"; error: string; attempts: Attempt[] };

export type Job = { prompt: string; schema: Schema; deadlineMs?: number };

/** The JSON object in an agent's answer: bare, fenced in ```json, or the outermost braces in prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const tries = [t];
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(t);
  if (fence) tries.push(fence[1]!.trim());
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a !== -1 && b > a) tries.push(t.slice(a, b + 1));
  for (const s of tries) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  throw new Error("the agent's answer contained no JSON object");
}

/** The agent's final answer text, by the output kind its configuration declares. */
export function answerText(kind: OutputKind, stdout: string): string {
  if (kind === "text") return stdout;
  if (kind === "claude-stream-json") {
    // The stream's last `result` line carries the final message, as `--output-format json` does.
    const result = stdout.split("\n").map(claudeStreamLine).findLast((l) => l.kind === "result");
    if (result?.kind !== "result") throw new Error("claude-stream-json output had no result line");
    if (result.isError) throw new Error("the CLI reported an error");
    if (result.text === null) throw new Error("claude-stream-json output had no result string");
    return result.text;
  }
  // `claude -p --output-format json`: one object whose `result` is the final message. The parser's
  // own message quotes the text it choked on, which would put the answer in the log.
  let o: { result?: unknown; is_error?: boolean };
  try {
    o = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
  } catch {
    throw new Error("claude-json output was not JSON");
  }
  if (o.is_error === true) throw new Error("the CLI reported an error");
  if (typeof o.result !== "string") throw new Error("claude-json output had no result string");
  return o.result;
}

/** An answer's token counts, as the CLI reported them; a count it left out is null. */
export type Usage = {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
};

/** The token counts in a Claude Code result's `usage`, or null when it has none. */
export function usageOf(v: unknown): Usage | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const u = v as Record<string, unknown>;
  const count = (k: string) => (Number.isInteger(u[k]) && (u[k] as number) >= 0 ? (u[k] as number) : null);
  return { input_tokens: count("input_tokens"), output_tokens: count("output_tokens"),
    cache_creation_input_tokens: count("cache_creation_input_tokens"), cache_read_input_tokens: count("cache_read_input_tokens") };
}

export type StreamLine =
  | { kind: "delta"; text: string }
  | { kind: "result"; isError: boolean; text: string | null; usage: Usage | null }
  | { kind: "restart" } // an `api_retry` line, or a `message_start` event: a request begun again
  | { kind: "other" };

/**
 * One line of `claude -p --output-format stream-json --include-partial-messages --verbose`
 * (checked against Claude Code 2.1.323): a text delta is a `stream_event` line whose `event` is
 * the API's `content_block_delta` with a `text_delta`; the last line is `result`, with `is_error`,
 * the final `result` text and `usage`. Everything else, thinking deltas and lines that are not
 * JSON included, is `other`.
 */
export function claudeStreamLine(line: string): StreamLine {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return { kind: "other" };
  }
  if (typeof o !== "object" || o === null) return { kind: "other" };
  const l = o as { type?: unknown; subtype?: unknown; event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } }; is_error?: unknown; result?: unknown; usage?: unknown };
  if (l.type === "stream_event" && l.event?.type === "content_block_delta" && l.event.delta?.type === "text_delta" && typeof l.event.delta.text === "string") {
    return { kind: "delta", text: l.event.delta.text };
  }
  if (l.type === "system" && l.subtype === "api_retry") return { kind: "restart" };
  if (l.type === "stream_event" && l.event?.type === "message_start") return { kind: "restart" };
  if (l.type === "result") return { kind: "result", isError: l.is_error === true, text: typeof l.result === "string" ? l.result : null, usage: usageOf(l.usage) };
  return { kind: "other" };
}

async function readCapped(stream: ReadableStream<Uint8Array>, onOverflow: () => void): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > MAX_OUTPUT) { onOverflow(); break; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function runAgent(agent: Agent, job: Job, timeoutMs: number): Promise<Attempt> {
  const started = Date.now();
  const program = agent.argv[0]!;
  const resolved = program.includes("/") ? program : Bun.which(program);
  if (resolved === null) return { agent: agent.name, status: "skipped", error: `${program}: not found on PATH`, ms: 0 };

  // Each run gets an empty working directory, so an agent with file tools starts with nothing.
  const work = mkdtempSync(join(tmpdir(), "school-bridge-run-"));
  const outputFile = join(work, "answer.txt");
  const onStdin = !usesPlaceholder(agent.argv, "{prompt}");
  const argv = expand(agent.argv, { "{prompt}": job.prompt, "{output_file}": outputFile });
  argv[0] = resolved;
  try {
    // detached: the agent leads its own process group, so a timeout can kill everything it started.
    const proc = Bun.spawn(argv, {
      cwd: work, detached: true, stdout: "pipe", stderr: "pipe",
      stdin: onStdin ? new TextEncoder().encode(job.prompt) : "ignore",
    });
    let why: string | null = null;
    const kill = (reason: string) => {
      why ??= reason;
      try { process.kill(-proc.pid, "SIGKILL"); } catch {}
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, () => kill("produced more than 1 MiB of output")),
      readCapped(proc.stderr, () => kill("produced more than 1 MiB of error output")),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    try { process.kill(-proc.pid, "SIGKILL"); } catch {} // anything it left running in the background
    const base = { agent: agent.name, exitCode, ms: Date.now() - started, stdout: stdout.slice(-TAIL), stderr: stderr.slice(-TAIL) };
    if (why !== null) return { ...base, status: "failed", error: why };
    if (exitCode !== 0) return { ...base, status: "failed", error: `exit ${exitCode}` };
    let output: unknown;
    try {
      const text = usesPlaceholder(agent.argv, "{output_file}") ? readFileSync(outputFile, "utf8") : answerText(agent.output, stdout);
      output = extractJson(text);
    } catch (e) {
      return { ...base, status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
    const invalid = validate(output, job.schema);
    if (invalid !== null) return { ...base, status: "failed", error: `the answer did not match the schema: ${invalid}` };
    return { ...base, status: "succeeded", output } as Attempt & { output: unknown };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Try each enabled agent in order until one succeeds, within an overall deadline if one is given. */
export async function runChain(cfg: Pick<BridgeConfig, "timeoutMs" | "agents">, job: Job): Promise<ChainResult> {
  const attempts: Attempt[] = [];
  const end = job.deadlineMs === undefined ? Infinity : Date.now() + job.deadlineMs;
  for (const agent of cfg.agents) {
    if (!agent.enabled) continue;
    const left = end - Date.now();
    if (left <= 0) {
      attempts.push({ agent: agent.name, status: "skipped", error: "the overall deadline had passed", ms: 0 });
      break;
    }
    const a = await runAgent(agent, job, Math.min(agent.timeoutMs, left));
    if (a.status === "succeeded") {
      const { output, ...rest } = a as Attempt & { output: unknown };
      attempts.push(rest);
      return { status: "succeeded", agent: agent.name, output, attempts };
    }
    attempts.push(a);
  }
  return { status: "failed", error: attempts.length === 0 ? "no agent is enabled" : "every agent failed", attempts };
}
