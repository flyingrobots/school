// Answering a learner's question (RFC 6 §5.4, flyingrobots/school#226). The agents of the `ask`
// list in bridge.json are tried in order, as the grading list's are, but the answer is passed on
// as the agent writes it: an agent with output `claude-stream-json` delivers each text delta as it
// arrives, and any other agent delivers its whole answer as one delta when it exits.
//
// The next agent is tried only before the first delta has been passed on. Once the learner has
// text from one agent, a failure ends the reply as failed: the answer never switches voices
// mid-sentence. Nothing here logs; the caller logs the attempts, which hold no prompt and no answer.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerText, claudeStreamLine, usageOf, type Agent, type AskConfig, type StreamLine, type Usage } from "./run.ts";
import { expand, usesPlaceholder } from "./template.ts";

export type { Usage } from "./run.ts";
export type AskAttempt = { agent: string; status: "succeeded" | "failed" | "skipped"; error: string | null; exitCode: number | null; ms: number; deltas: number };
export type AskResult =
  | { status: "succeeded"; agent: string; usage: Usage | null; attempts: AskAttempt[] }
  | { status: "failed"; agent: string | null; error: string; attempts: AskAttempt[] };
/** A question's prompt; an overall deadline, if any; and a signal that the caller has gone. */
export type AskJob = { prompt: string; deadlineMs?: number; signal?: AbortSignal };

// A streamed answer repeats its text in the stream's framing, the final message and the result
// line, so the cap is larger than a grading's 1 MiB.
const MAX_OUTPUT = 8 * 1024 * 1024;
const PIPE_GRACE_MS = 500;
const GONE = "the caller went away";

/** Try each enabled ask agent in order, passing its answer on through `onDelta` as it is written. */
export async function runAsk(cfg: AskConfig, job: AskJob, onDelta: (text: string) => void): Promise<AskResult> {
  const attempts: AskAttempt[] = [];
  if (job.signal?.aborted) return { status: "failed", agent: null, error: GONE, attempts };
  const end = job.deadlineMs === undefined ? Infinity : Date.now() + job.deadlineMs;
  for (const agent of cfg.agents) {
    if (!agent.enabled) continue;
    const left = end - Date.now();
    if (left <= 0) {
      attempts.push({ agent: agent.name, status: "skipped", error: "the overall deadline had passed", exitCode: null, ms: 0, deltas: 0 });
      break;
    }
    const { attempt, usage } = await askAgent(agent, job, Math.min(agent.timeoutMs, left), onDelta);
    attempts.push(attempt);
    if (attempt.status === "succeeded") return { status: "succeeded", agent: agent.name, usage, attempts };
    // After the first delta, or once the caller has gone, no other agent is tried. The reply names
    // the agent only if the caller received some of its words.
    if (attempt.deltas > 0 || job.signal?.aborted) return { status: "failed", agent: attempt.deltas > 0 ? agent.name : null, error: attempt.error ?? "failed", attempts };
  }
  return { status: "failed", agent: null, error: attempts.length === 0 ? "no ask agent is enabled" : "every ask agent failed", attempts };
}

/**
 * Read `stream` line by line, calling `onLine` for each as it arrives; the whole text if `keep`.
 * Past `cap` bytes it calls `onOverflow` and stops. Each reader is pushed onto `readers`, so a
 * caller can cancel them once a kill has had its grace (POST /author reads its agent's this way).
 */
export async function readLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void, keep: boolean, onOverflow: () => void, readers: ReadableStreamDefaultReader<Uint8Array>[], cap = MAX_OUTPUT): Promise<string> {
  const decoder = new TextDecoder();
  let held = "";
  let all = "";
  let size = 0;
  const reader = stream.getReader();
  readers.push(reader);
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    size += chunk.length;
    if (size > cap) { onOverflow(); break; }
    const text = decoder.decode(chunk, { stream: true });
    if (keep) all += text;
    held += text;
    let at: number;
    while ((at = held.indexOf("\n")) !== -1) {
      onLine(held.slice(0, at));
      held = held.slice(at + 1);
    }
  }
  const rest = decoder.decode();
  if (keep) all += rest;
  held += rest;
  if (held !== "") onLine(held);
  return all;
}

async function askAgent(agent: Agent, job: AskJob, timeoutMs: number, onDelta: (text: string) => void): Promise<{ attempt: AskAttempt; usage: Usage | null }> {
  const started = Date.now();
  const program = agent.argv[0]!;
  const resolved = program.includes("/") ? program : Bun.which(program);
  if (resolved === null) return { attempt: { agent: agent.name, status: "skipped", error: `${program}: not found on PATH`, exitCode: null, ms: 0, deltas: 0 }, usage: null };

  let deltas = 0;
  const pass = (text: string) => {
    if (text === "") return;
    deltas++;
    onDelta(text);
  };
  // Each run gets an empty working directory, so an agent with file tools starts with nothing.
  const work = mkdtempSync(join(tmpdir(), "school-bridge-ask-"));
  const outputFile = join(work, "answer.txt");
  const toFile = usesPlaceholder(agent.argv, "{output_file}");
  const streaming = agent.output === "claude-stream-json" && !toFile;
  const argv = expand(agent.argv, { "{prompt}": job.prompt, "{output_file}": outputFile });
  argv[0] = resolved;
  try {
    // detached: the agent leads its own process group, so a kill ends everything it started.
    const proc = Bun.spawn(argv, {
      cwd: work, detached: true, stdout: "pipe", stderr: "pipe",
      stdin: usesPlaceholder(agent.argv, "{prompt}") ? "ignore" : new TextEncoder().encode(job.prompt),
    });
    let why: string | null = null;
    let sweep: ReturnType<typeof setInterval> | null = null;
    const hit = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch {} };
    const kill = (reason: string) => {
      why ??= reason;
      hit();
      // A child the agent forks just as the signal lands can miss it, still in the group, and hold
      // the pipes open until the timeout: sweep the group until they close.
      sweep ??= setInterval(hit, 50);
      grace ??= setTimeout(() => { for (const r of readers) r.cancel().catch(() => {}); }, PIPE_GRACE_MS);
    };
    // A child that left the group holds the pipes open however often the group is killed. Once
    // the kill has had this long to close them, stop reading, so the caller is not kept waiting.
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    let grace: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => kill(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const gone = () => kill(GONE);
    job.signal?.addEventListener("abort", gone);
    let result: Extract<StreamLine, { kind: "result" }> | null = null;
    const onLine = (line: string) => {
      if (!streaming || why !== null) return;
      const l = claudeStreamLine(line);
      if (l.kind === "delta") pass(l.text);
      // Claude Code retrying its request streams the answer again from its start. Before any delta
      // that is harmless; after one, the learner would see the answer twice, so the reply fails.
      else if (l.kind === "restart") { if (deltas > 0) kill("the agent started the answer again after its first delta"); }
      else if (l.kind === "result") result = l;
    };
    const [stdout] = await Promise.all([
      readLines(proc.stdout, onLine, !streaming, () => kill("produced more than 8 MiB of output"), readers),
      readLines(proc.stderr, () => {}, false, () => kill("produced more than 8 MiB of error output"), readers),
    ]);
    if (sweep !== null) clearInterval(sweep);
    if (grace !== null) clearTimeout(grace);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    job.signal?.removeEventListener("abort", gone);
    try { process.kill(-proc.pid, "SIGKILL"); } catch {} // anything it left running in the background
    const base = { agent: agent.name, exitCode, ms: Date.now() - started };
    const failed = (error: string) => ({ attempt: { ...base, status: "failed" as const, error, deltas }, usage: null });
    const succeeded = (usage: Usage | null) => ({ attempt: { ...base, status: "succeeded" as const, error: null, deltas }, usage });
    if (why !== null) return failed(why);
    if (exitCode !== 0) return failed(`exit ${exitCode}`);

    if (streaming) {
      const r = result as Extract<StreamLine, { kind: "result" }> | null;
      if (r === null) return failed("claude-stream-json output had no result line");
      if (r.isError) return failed("the CLI reported an error");
      // Run without --include-partial-messages, the CLI streams no deltas: its result is the answer.
      if (deltas === 0 && r.text !== null && r.text.trim() !== "") pass(r.text);
      return deltas === 0 ? failed("the agent gave no answer") : succeeded(r.usage);
    }

    let text: string;
    let usage: Usage | null = null;
    try {
      text = toFile ? readFileSync(outputFile, "utf8") : answerText(agent.output, stdout);
      if (!toFile && agent.output === "claude-json") usage = usageOf((JSON.parse(stdout) as { usage?: unknown }).usage);
    } catch (e) {
      return failed(e instanceof Error ? e.message : String(e));
    }
    if (text.trim() === "") return failed("the agent gave no answer");
    pass(text);
    return succeeded(usage);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
