// The agent chain (RFC 1 proposal 4). Each agent is a command template the learner wrote. They
// are tried in order, a hierarchy of fallbacks: an agent that is missing, disabled, fails, times
// out, or returns output that does not match the requested schema hands over to the next one.
// Every attempt is reported, so the server can keep the whole record.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate, type Schema } from "./schema.ts";
import { TemplateError, expand, splitCommand, usesPlaceholder } from "./template.ts";

export const OUTPUTS = ["text", "claude-json"] as const;
export type OutputKind = (typeof OUTPUTS)[number];

export type Agent = { name: string; argv: string[]; output: OutputKind; timeoutMs: number; enabled: boolean };
export type BridgeConfig = { timeoutMs: number; agents: Agent[] };

const MAX_OUTPUT = 1024 * 1024;
const TAIL = 4000;

export class BridgeConfigError extends Error {}

/** Parse and check a configuration object (the parsed bridge.json). Throws BridgeConfigError. */
export function loadConfig(raw: unknown): BridgeConfig {
  const fail = (m: string): never => { throw new BridgeConfigError(m); };
  if (typeof raw !== "object" || raw === null) fail("the configuration must be a JSON object");
  const o = raw as Record<string, unknown>;
  const seconds = (v: unknown, where: string) => {
    const n = v === undefined ? 180 : v;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 900) fail(`${where}timeout_seconds must be an integer from 1 to 900`);
    return (n as number) * 1000;
  };
  const timeoutMs = seconds(o.timeout_seconds, "");
  if (!Array.isArray(o.agents) || o.agents.length === 0) fail("list at least one agent under \"agents\"");
  const seen = new Set<string>();
  const agents = (o.agents as unknown[]).map((a, i): Agent => {
    if (typeof a !== "object" || a === null) fail(`agent ${i + 1} must be an object`);
    const x = a as Record<string, unknown>;
    if (typeof x.name !== "string" || x.name === "") fail(`agent ${i + 1} needs a "name"`);
    const name = x.name as string;
    if (seen.has(name)) fail(`agent "${name}" is listed twice`);
    seen.add(name);
    if (typeof x.command !== "string") fail(`agent "${name}" needs a "command", like: claude -p {prompt}`);
    let argv: string[] = [];
    try {
      argv = splitCommand(x.command as string);
    } catch (e) {
      fail(`agent "${name}": ${e instanceof TemplateError ? e.message : String(e)}`);
    }
    const output = (x.output ?? "text") as OutputKind;
    if (!OUTPUTS.includes(output)) fail(`agent "${name}": output must be one of ${OUTPUTS.join(", ")}`);
    const ownTimeout = x.timeout_seconds === undefined ? timeoutMs : seconds(x.timeout_seconds, `agent "${name}": `);
    return { name, argv, output, timeoutMs: ownTimeout, enabled: x.enabled !== false };
  });
  return { timeoutMs, agents };
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
function answerText(kind: OutputKind, stdout: string): string {
  if (kind === "text") return stdout;
  // `claude -p --output-format json`: one object whose `result` is the final message.
  const o = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
  if (o.is_error === true) throw new Error("the CLI reported an error");
  if (typeof o.result !== "string") throw new Error("claude-json output had no result string");
  return o.result;
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
export async function runChain(cfg: BridgeConfig, job: Job): Promise<ChainResult> {
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
