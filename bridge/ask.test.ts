// Answering a question (RFC 6 §5.4, flyingrobots/school#226): the `ask` list's agents are tried in
// order until one answers, and the answer is passed on as it is written. Fake agents are shell
// scripts (bridge/testing/fake-agent.ts); none contacts a model. The oracle for every expectation
// here is RFC 6 Table 5.4: deltas as the agent writes, fallback only before the first delta, and
// one end with the agent, its status and its usage.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAsk } from "./ask.ts";
import { loadConfig, type AskConfig } from "./run.ts";
import { fakeAgent, plainAgent, USAGE, type Step } from "./testing/fake-agent.ts";

// Bun's own 5 s limit would race process start-up on a loaded machine; each test ends on its own
// or by the agent timeouts it sets.
setDefaultTimeout(60_000);

let dir = "";
let gates = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "school-bridge-ask-"));
  gates = mkdtempSync(join(tmpdir(), "school-bridge-gates-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(gates, { recursive: true, force: true });
});

const open = (name: string) => writeFileSync(join(gates, name), "");
const reached = (name: string) => existsSync(join(gates, name));

type Spec = { name: string; steps?: Step[]; command?: string; output?: string; timeout_seconds?: number };
/** An ask list of fake agents, each run as `<script> <gate folder> {prompt}`. */
function ask(agents: Spec[], timeout = 30): AskConfig {
  const c = loadConfig({
    agents: [{ name: "grader", command: "true" }],
    ask: { timeout_seconds: timeout, agents: agents.map(({ name, steps, command, output, timeout_seconds }) => ({
      name, output: output ?? "claude-stream-json", ...(timeout_seconds === undefined ? {} : { timeout_seconds }),
      command: command ?? `${fakeAgent(dir, name, steps ?? [])} ${gates} {prompt}`,
    })) },
  });
  if (c.ask === null) throw new Error("the ask list did not load");
  return c.ask;
}

test("golden: three deltas each reach the caller before the agent goes on, then the end names the agent and its usage", async () => {
  const cfg = ask([{ name: "claude", steps: [
    { delta: "One " }, { gate: "1" }, { delta: "two " }, { gate: "2" }, { thinking: "never shown" }, { delta: "three." }, { gate: "3" },
    { result: "One two three." }, { mark: "exited" }, { exit: 0 },
  ] }]);
  // Each delta opens the gate the agent waits at next, so if a delta were held back until the
  // agent exited, the agent would wait at its gate until it timed out and the run would fail.
  const seen: [string, boolean][] = [];
  const r = await runAsk(cfg, { prompt: "What is a passage?" }, (text) => {
    seen.push([text, reached("exited")]);
    open(String(seen.length));
  });
  expect(seen).toEqual([["One ", false], ["two ", false], ["three.", false]]);
  expect(r).toEqual({ status: "succeeded", agent: "claude", usage: USAGE,
    attempts: [{ agent: "claude", status: "succeeded", error: null, exitCode: 0, ms: expect.any(Number), deltas: 3 }] });
});

test("an agent that exits before any delta hands over to the next, whose answer is the only one passed on", async () => {
  const cfg = ask([
    { name: "first", steps: [{ stderr: "boom" }, { exit: 3 }] },
    { name: "second", steps: [{ delta: "Hello." }, { result: "Hello." }] },
  ]);
  const deltas: string[] = [];
  const r = await runAsk(cfg, { prompt: "p" }, (t) => deltas.push(t));
  expect(deltas).toEqual(["Hello."]);
  expect(r).toMatchObject({ status: "succeeded", agent: "second" });
  expect(r.attempts.map((a) => [a.agent, a.status, a.error, a.deltas])).toEqual([["first", "failed", "exit 3", 0], ["second", "succeeded", null, 1]]);
});

test("a CLI error result before any delta hands over to the next agent", async () => {
  const cfg = ask([
    { name: "first", steps: [{ result: "rate limited", isError: true }] },
    { name: "second", steps: [{ delta: "Hi." }, { result: "Hi." }] },
  ]);
  const r = await runAsk(cfg, { prompt: "p" }, () => {});
  expect(r.attempts.map((a) => [a.agent, a.status, a.error])).toEqual([["first", "failed", "the CLI reported an error"], ["second", "succeeded", null]]);
});

test("a failure after the first delta ends the reply as failed, naming that agent, and no other agent runs", async () => {
  const cfg = ask([
    { name: "first", steps: [{ delta: "Half an " }, { exit: 1 }] },
    { name: "second", steps: [{ mark: "second-ran" }, { delta: "Another voice." }, { result: "Another voice." }] },
  ]);
  const deltas: string[] = [];
  const r = await runAsk(cfg, { prompt: "p" }, (t) => deltas.push(t));
  expect(deltas).toEqual(["Half an "]);
  expect(r).toEqual({ status: "failed", agent: "first", error: "exit 1",
    attempts: [{ agent: "first", status: "failed", error: "exit 1", exitCode: 1, ms: expect.any(Number), deltas: 1 }] });
  expect(reached("second-ran")).toBe(false);
});

test("a CLI error result after a delta ends the reply as failed", async () => {
  const cfg = ask([
    { name: "first", steps: [{ delta: "Some " }, { result: "Some", isError: true }] },
    { name: "second", steps: [{ mark: "second-ran" }, { result: "x" }] },
  ]);
  const r = await runAsk(cfg, { prompt: "p" }, () => {});
  expect(r).toMatchObject({ status: "failed", agent: "first", error: "the CLI reported an error" });
  expect(reached("second-ran")).toBe(false);
});

test("an agent that hangs before any delta is killed at its timeout and the next agent answers", async () => {
  const cfg = ask([
    { name: "hangs", steps: [{ hang: true }], timeout_seconds: 1 },
    { name: "second", steps: [{ delta: "Here." }, { result: "Here." }] },
  ]);
  const r = await runAsk(cfg, { prompt: "p" }, () => {});
  expect(r).toMatchObject({ status: "succeeded", agent: "second" });
  expect(r.attempts[0]).toMatchObject({ agent: "hangs", status: "failed", error: "timed out after 1 s", deltas: 0 });
});

test("an agent that hangs after a delta is killed at its timeout and the reply ends as failed", async () => {
  // The case needs the delta to arrive before the timeout fires. On a loaded machine a shell can
  // take longer than the timeout just to start, so a run with no delta proves nothing about this
  // case and is repeated with double the timeout.
  for (const seconds of [1, 2, 4, 8, 16]) {
    const cfg = ask([
      { name: `hangs-${seconds}`, steps: [{ delta: "Partly " }, { hang: true }], timeout_seconds: seconds },
      { name: `second-${seconds}`, steps: [{ mark: `second-ran-${seconds}` }, { result: "x" }] },
    ]);
    const r = await runAsk(cfg, { prompt: "p" }, () => {});
    if (r.attempts[0]!.deltas === 0) continue; // timed out before it wrote: inconclusive, not a pass
    expect(r).toMatchObject({ status: "failed", agent: `hangs-${seconds}`, error: `timed out after ${seconds} s` });
    expect(r.attempts).toHaveLength(1);
    expect(reached(`second-ran-${seconds}`)).toBe(false);
    return;
  }
  throw new Error("the hanging agent never wrote its delta, even with a 16 s timeout");
});

test("an overall deadline stops the list rather than running past it", async () => {
  const cfg = ask([{ name: "hangs", steps: [{ hang: true }] }, { name: "second", steps: [{ mark: "second-ran" }, { result: "x" }] }]);
  const r = await runAsk(cfg, { prompt: "p", deadlineMs: 800 }, () => {});
  expect(r.status).toBe("failed");
  expect(r.attempts.map((a) => a.agent)).toEqual(["hangs", "second"]);
  expect(r.attempts.at(-1)).toMatchObject({ status: "skipped", error: "the overall deadline had passed" });
  expect(reached("second-ran")).toBe(false);
});

// The agent's timeout is far longer than the test's own limit, so an agent left running fails the test.
test("a caller that goes away stops the agent, and the reply ends as failed", async () => {
  const cfg = ask([{ name: "claude", steps: [{ delta: "Start " }, { hang: true }] }], 600);
  const gone = new AbortController();
  const r = await runAsk(cfg, { prompt: "p", signal: gone.signal }, () => gone.abort());
  expect(r).toMatchObject({ status: "failed", agent: "claude", error: "the caller went away" });
}, 15_000);

test("a caller already gone runs no agent", async () => {
  const cfg = ask([{ name: "claude", steps: [{ mark: "ran" }, { result: "x" }] }]);
  const gone = new AbortController();
  gone.abort();
  const r = await runAsk(cfg, { prompt: "p", signal: gone.signal }, () => {});
  expect(r).toEqual({ status: "failed", agent: null, error: "the caller went away", attempts: [] });
  expect(reached("ran")).toBe(false);
});

test("a stream-json agent run without partial messages delivers its result as one delta at the end", async () => {
  const cfg = ask([{ name: "claude", steps: [{ result: "The whole answer." }] }]);
  const deltas: string[] = [];
  const r = await runAsk(cfg, { prompt: "p" }, (t) => deltas.push(t));
  expect(deltas).toEqual(["The whole answer."]);
  expect(r).toMatchObject({ status: "succeeded", usage: USAGE });
});

test("lines that are not JSON are ignored; the usage counts that are missing are null", async () => {
  const cfg = ask([{ name: "claude", steps: [{ line: "not json" }, { delta: "Fine." }, { result: "Fine.", usage: { input_tokens: 7, output_tokens: 2 } }] }]);
  const r = await runAsk(cfg, { prompt: "p" }, () => {});
  expect(r).toMatchObject({ status: "succeeded",
    usage: { input_tokens: 7, output_tokens: 2, cache_creation_input_tokens: null, cache_read_input_tokens: null } });
});

test("an agent with output text still answers, as one delta at the end, with no usage", async () => {
  const say = plainAgent(dir, "say", `printf 'A plain answer.\\n'`);
  const deltas: string[] = [];
  const r = await runAsk(ask([{ name: "plain", command: `${say} {prompt}`, output: "text" }]), { prompt: "p" }, (t) => deltas.push(t));
  expect(deltas).toEqual(["A plain answer.\n"]);
  expect(r).toMatchObject({ status: "succeeded", agent: "plain", usage: null });
});

test("an agent with output claude-json answers as one delta, with its usage", async () => {
  const json = plainAgent(dir, "json", `printf '%s\\n' '${JSON.stringify({ type: "result", is_error: false, result: "From JSON.", usage: USAGE })}'`);
  const deltas: string[] = [];
  const r = await runAsk(ask([{ name: "json", command: `${json} {prompt}`, output: "claude-json" }]), { prompt: "p" }, (t) => deltas.push(t));
  expect(deltas).toEqual(["From JSON."]);
  expect(r).toMatchObject({ status: "succeeded", usage: USAGE });
});

test("an agent that writes {output_file} answers with that file, as one delta", async () => {
  const toFile = plainAgent(dir, "to-file", `echo "progress chatter"; printf 'From the file.' > "$1"`);
  const deltas: string[] = [];
  const r = await runAsk(ask([{ name: "codex", command: `${toFile} {output_file}`, output: "text" }]), { prompt: "p" }, (t) => deltas.push(t));
  expect(deltas).toEqual(["From the file."]);
  expect(r.status).toBe("succeeded");
});

test("an agent that answers nothing at all has failed, and the next one is tried", async () => {
  const silent = plainAgent(dir, "silent", "exit 0");
  const r = await runAsk(ask([{ name: "silent", command: silent, output: "text" }, { name: "second", steps: [{ delta: "Yes." }, { result: "Yes." }] }]), { prompt: "p" }, () => {});
  expect(r.attempts.map((a) => [a.agent, a.status, a.error])).toEqual([["silent", "failed", "the agent gave no answer"], ["second", "succeeded", null]]);
});

test("{prompt} arrives as one argument, exactly; without it the prompt is on stdin", async () => {
  const prompt = `line one "quoted" $(touch ${dir}/pwned)\nline two`;
  const arg = plainAgent(dir, "arg", `printf '%s' "$2" > "${dir}/arg-saw.txt"; echo ok`);
  const stdin = plainAgent(dir, "stdin", `cat > "${dir}/stdin-saw.txt"; echo ok`);
  await runAsk(ask([{ name: "arg", command: `${arg} -p {prompt}`, output: "text" }]), { prompt }, () => {});
  await runAsk(ask([{ name: "stdin", command: stdin, output: "text" }]), { prompt }, () => {});
  expect(readFileSync(join(dir, "arg-saw.txt"), "utf8")).toBe(prompt);
  expect(readFileSync(join(dir, "stdin-saw.txt"), "utf8")).toBe(prompt);
  expect(existsSync(join(dir, "pwned"))).toBe(false);
});

test("a missing program or a disabled agent is skipped and recorded", async () => {
  const r = await runAsk(ask([
    { name: "missing", command: "definitely-not-a-real-cli-xyz {prompt}" },
    { name: "good", steps: [{ delta: "Yes." }, { result: "Yes." }] },
  ]), { prompt: "p" }, () => {});
  expect(r.attempts.map((a) => [a.agent, a.status])).toEqual([["missing", "skipped"], ["good", "succeeded"]]);
  const none = await runAsk({ timeoutMs: 1000, agents: [] }, { prompt: "p" }, () => {});
  expect(none).toEqual({ status: "failed", agent: null, error: "no ask agent is enabled", attempts: [] });
});

test("the ask list is optional, its own timeout defaults to 90 s, and it is checked like the grading list", () => {
  const grader = [{ name: "grader", command: "true" }];
  expect(loadConfig({ agents: grader }).ask).toBeNull();
  const c = loadConfig({ timeout_seconds: 180, agents: grader, ask: { agents: [
    { name: "claude", command: "claude -p {prompt}", output: "claude-stream-json" },
    { name: "codex", command: "codex exec -o {output_file}", timeout_seconds: 30, enabled: false },
  ] } });
  expect(c.ask).toEqual({ timeoutMs: 90_000, agents: [
    { name: "claude", argv: ["claude", "-p", "{prompt}"], output: "claude-stream-json", timeoutMs: 90_000, enabled: true },
    { name: "codex", argv: ["codex", "exec", "-o", "{output_file}"], output: "text", timeoutMs: 30_000, enabled: false },
  ] });
  expect(() => loadConfig({ agents: grader, ask: [] })).toThrow(/"ask" must be an object/);
  expect(() => loadConfig({ agents: grader, ask: { agents: [] } })).toThrow(/at least one agent under "ask"/);
  expect(() => loadConfig({ agents: grader, ask: { timeout_seconds: 0, agents: grader } })).toThrow(/ask: timeout_seconds/);
  expect(() => loadConfig({ agents: grader, ask: { agents: [{ name: "x", command: "a" }, { name: "x", command: "b" }] } })).toThrow(/ask agent "x" is listed twice/);
  expect(() => loadConfig({ agents: grader, ask: { agents: [{ name: "x", command: "a", output: "telepathy" }] } })).toThrow(/claude-stream-json/);
});

test("the example configuration loads, its first ask agent streaming", () => {
  const example = loadConfig(JSON.parse(readFileSync(join(import.meta.dir, "bridge.example.json"), "utf8")));
  expect(example.ask?.timeoutMs).toBe(90_000);
  expect(example.ask?.agents.map((a) => [a.name, a.output])).toEqual([["claude", "claude-stream-json"], ["codex", "text"]]);
  // Claude Code 2.1.323 refuses --output-format stream-json under -p without --verbose, and streams
  // deltas only with --include-partial-messages.
  expect(example.ask?.agents[0]!.argv).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--include-partial-messages", "--verbose", "-p", "{prompt}"]));
});
