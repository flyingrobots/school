// The bridge's POST /ask over HTTP, as the real process (RFC 6 §5.4, flyingrobots/school#226): an
// answer streamed as NDJSON, from the `ask` agents, in a queue of their own. Fake agents are shell
// scripts (bridge/testing/fake-agent.ts); none contacts a model.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, timeout, type Started } from "../server/testing/processes.ts";
import { fakeAgent, plainAgent, USAGE, type Step } from "./testing/fake-agent.ts";

const TOKEN = "ask-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
let dir = "";
let gates = "";
let bridge: Started | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "school-bridge-ask-http-"));
  gates = mkdtempSync(join(tmpdir(), "school-bridge-ask-gates-"));
});
afterEach(async () => {
  bridge?.proc.kill();
  await bridge?.proc.exited;
  bridge = null;
  rmSync(dir, { recursive: true, force: true });
  rmSync(gates, { recursive: true, force: true });
});

const open = (name: string) => writeFileSync(join(gates, name), "");
const reached = (name: string) => existsSync(join(gates, name));
/** Wait for a gate file the agent creates; a test that never sees it fails on its own timeout. */
async function waitFor(name: string) {
  while (!reached(name)) await Bun.sleep(10);
}

/** A bridge whose grading list is `grading` and whose ask list is the fake agents `ask` (none: no ask list). */
async function start(grading: { name: string; command: string }[], ask: { name: string; steps: Step[] }[] | null) {
  const config: Record<string, unknown> = { timeout_seconds: 30, agents: grading };
  if (ask !== null) config.ask = { timeout_seconds: 30, agents: ask.map((a) => ({ name: a.name, output: "claude-stream-json", command: `${fakeAgent(dir, a.name, a.steps)} ${gates} {prompt}` })) };
  writeFileSync(join(dir, "bridge.json"), JSON.stringify(config));
  bridge = await startBridge({ ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "bridge.json") });
  return bridge;
}

const post = (path: string, body: unknown, headers: Record<string, string> = auth, signal?: AbortSignal) =>
  fetch(bridge!.url + path, { method: "POST", headers, body: JSON.stringify(body), signal });

/** The NDJSON lines of a response, one at a time, as they arrive. */
async function* lines(r: Response) {
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  let held = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    held += value;
    let at: number;
    while ((at = held.indexOf("\n")) !== -1) {
      yield JSON.parse(held.slice(0, at)) as Record<string, unknown>;
      held = held.slice(at + 1);
    }
  }
  if (held !== "") throw new Error(`a partial line at the end: ${held}`);
}
async function all(r: Response) {
  const out: Record<string, unknown>[] = [];
  for await (const l of lines(r)) out.push(l);
  return out;
}

const grader = (name: string, body: string) => ({ name, command: `${plainAgent(dir, name, body)} {prompt}` });
const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };

test("POST /ask streams each delta to the caller as NDJSON before the agent exits, then one end line", async () => {
  await start([grader("g", `echo '{"ok": true}'`)], [{ name: "claude", steps: [
    { delta: "One " }, { gate: "1" }, { delta: "two " }, { gate: "2" }, { delta: "three." }, { gate: "3" }, { result: "One two three." }, { mark: "exited" },
  ] }]);
  const r = await post("/ask", { prompt: "What does this mean?" });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/x-ndjson");
  // Each line opens the gate the agent waits at next: a line held until the agent exits would
  // leave the agent waiting until its timeout.
  const got: [Record<string, unknown>, boolean][] = [];
  for await (const l of lines(r)) {
    got.push([l, reached("exited")]);
    if (l.type === "delta") open(String(got.length));
  }
  expect(got).toEqual([
    [{ type: "delta", text: "One " }, false], [{ type: "delta", text: "two " }, false], [{ type: "delta", text: "three." }, false],
    [{ type: "end", status: "succeeded", agent: "claude", usage: USAGE, error: null,
      attempts: [{ agent: "claude", status: "succeeded", ms: expect.any(Number), exit_code: 0, error: null, deltas: 3 }] }, true],
  ]);
}, timeout(1));

test("a grading in progress does not delay a question", async () => {
  // The grading agent says it has started, then waits until the test lets it finish.
  await start([grader("slow", `: > "${gates}/grading"; while [ ! -e "${gates}/finish-grading" ]; do [ -d "${gates}" ] || exit 1; sleep 0.01; done; echo '{"ok": true}'`)],
    [{ name: "claude", steps: [{ delta: "Answered." }, { result: "Answered." }] }]);
  const grading = post("/run", { prompt: "grade this", schema });
  await waitFor("grading");
  const answer = await all(await post("/ask", { prompt: "a question" }));
  expect(answer.map((l) => l.type)).toEqual(["delta", "end"]);
  expect(answer.at(-1)).toMatchObject({ status: "succeeded", agent: "claude" });
  expect(reached("finish-grading")).toBe(false); // the grading is still running
  open("finish-grading");
  expect(await (await grading).json()).toMatchObject({ status: "succeeded", output: { ok: true } });
}, timeout(1));

test("interleaved gradings and questions: each reply is its own, every grading succeeds, no log line holds a prompt or an answer", async () => {
  await start([grader("g", `echo '{"ok": true}'`)], [{ name: "claude", steps: [{ delta: "Re: " }, { echoPrompt: true }, { result: "done" }] }]);
  const N = 8;
  const questions = Array.from({ length: N }, (_, i) => `QUESTION-${i}-${crypto.randomUUID().slice(0, 8)}`);
  const gradings = Array.from({ length: N }, (_, i) => `GRADING-${i}-${crypto.randomUUID().slice(0, 8)}`);
  const [answers, graded] = await Promise.all([
    Promise.all(questions.map(async (q) => all(await post("/ask", { prompt: q })))),
    Promise.all(gradings.map(async (g) => (await post("/run", { prompt: g, schema })).json())),
  ]);
  answers.forEach((a, i) => expect(a).toMatchObject([{ type: "delta", text: "Re: " }, { type: "delta", text: questions[i] }, { type: "end", status: "succeeded" }]));
  for (const g of graded) expect(g).toMatchObject({ status: "succeeded" });
  bridge!.proc.kill();
  const { stdout } = await bridge!.output();
  bridge = null;
  const kinds = stdout.trim().split("\n").map((l) => JSON.parse(l).kind as string);
  expect(kinds.filter((k) => k === "bridge.ask.end")).toHaveLength(N);
  expect(kinds.filter((k) => k === "bridge.run.end")).toHaveLength(N);
  for (const text of [...questions, ...gradings, "Re: "]) expect(stdout).not.toContain(text);
}, timeout(1));

test("with no ask list, POST /ask is one failed end line naming the configuration file", async () => {
  await start([grader("g", `echo '{"ok": true}'`)], null);
  const out = await all(await post("/ask", { prompt: "p" }));
  expect(out).toEqual([{ type: "end", status: "failed", agent: null, usage: null, attempts: [], error: expect.stringContaining(join(dir, "bridge.json")) }]);
}, timeout(1));

test("POST /ask refuses a request without the token, a body that is not JSON, and a bad prompt or deadline", async () => {
  await start([grader("g", "true")], [{ name: "claude", steps: [{ mark: "ran" }, { result: "x" }] }]);
  expect((await post("/ask", { prompt: "p" }, { "content-type": "application/json" })).status).toBe(401);
  expect((await post("/ask", { prompt: "p" }, { authorization: auth.authorization, "content-type": "text/plain" })).status).toBe(415);
  expect((await fetch(bridge!.url + "/ask", { method: "POST", headers: auth, body: "{ not json" })).status).toBe(400);
  for (const body of [{}, { prompt: "" }, { prompt: "x".repeat(200_001) }, { prompt: "p", deadline_ms: 0 }, { prompt: "p", deadline_ms: 1.5 }]) {
    expect([JSON.stringify(body).slice(0, 40), (await post("/ask", body)).status]).toEqual([JSON.stringify(body).slice(0, 40), 400]);
  }
  expect((await fetch(bridge!.url + "/ask", { headers: auth })).status).toBe(405);
  expect(reached("ran")).toBe(false);
}, timeout(1));

test("a caller that hangs up stops the agent, which frees the ask queue for the next question", async () => {
  await start([grader("g", "true")], [{ name: "claude", steps: [{ mark: "started" }, { delta: "Start " }, { gate: "never" }, { result: "x" }] }]);
  const hangUp = new AbortController();
  const first = await post("/ask", { prompt: "p" }, auth, hangUp.signal);
  const reader = lines(first);
  expect((await reader.next()).value).toEqual({ type: "delta", text: "Start " });
  hangUp.abort();
  // The next question reaches the same first agent only once the hung-up one has been stopped.
  rmSync(join(gates, "started"));
  const next = post("/ask", { prompt: "q" });
  await waitFor("started");
  open("never");
  expect((await all(await next)).at(-1)).toMatchObject({ status: "succeeded", agent: "claude" });
  bridge!.proc.kill();
  const { stdout } = await bridge!.output();
  bridge = null;
  const ends = stdout.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "bridge.ask.end");
  expect(ends.map((l) => [l.status, l.agent])).toEqual([["failed", "claude"], ["succeeded", "claude"]]);
}, timeout(1));

// flyingrobots/school#290: an ask agent that cannot be started is a failed attempt, and the next is tried.
test("a question whose first agent cannot be started falls back to the next and logs that attempt as failed", async () => {
  const unstartable = join(dir, "no-such-folder", "agent");
  writeFileSync(join(dir, "bridge.json"), JSON.stringify({ timeout_seconds: 30, agents: [grader("g", "true")], ask: { timeout_seconds: 30, agents: [
    { name: "unstartable", output: "claude-stream-json", command: `${unstartable} {prompt}` },
    { name: "claude", output: "claude-stream-json", command: `${fakeAgent(dir, "claude", [{ delta: "Yes." }, { result: "Yes." }])} ${gates} {prompt}` },
  ] } }));
  bridge = await startBridge({ ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "bridge.json") });
  const out = await all(await post("/ask", { prompt: "SECRET-LEARNER-TEXT" }));
  expect(out.map((l) => l.type)).toEqual(["delta", "end"]);
  expect(out.at(-1)).toMatchObject({ status: "succeeded", agent: "claude" });
  bridge!.proc.kill();
  const { stdout } = await bridge!.output();
  bridge = null;
  const attempts = stdout.trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "bridge.ask.attempt");
  expect(attempts.map((a) => [a.agent, a.status, a.error])).toEqual([["unstartable", "failed", `could not start ${unstartable} (ENOENT)`], ["claude", "succeeded", null]]);
  expect(stdout).not.toContain("SECRET-LEARNER-TEXT");
}, timeout(1));
