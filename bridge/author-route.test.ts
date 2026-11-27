// The bridge's POST /author over HTTP, as the real process (RFC 9 Table 5.1, flyingrobots/school#259):
// a draft's steps streamed as NDJSON, then its course files and one end line, from the `author`
// agents in a queue of their own. Fake agents are shell scripts (bridge/testing/fake-agent.ts); none
// contacts a model.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBridge, timeout, type Started } from "../server/testing/processes.ts";
import { fakeAgent, plainAgent, USAGE, type Step } from "./testing/fake-agent.ts";

const TOKEN = "author-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
let dir = "";
let gates = "";
let bridge: Started | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "school-bridge-author-http-"));
  gates = mkdtempSync(join(tmpdir(), "school-bridge-author-gates-"));
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
async function waitFor(name: string) {
  while (!reached(name)) await Bun.sleep(10);
}

type Fake = { name: string; steps: Step[] };
/** A bridge with a grading list, an ask list and an author list; each list's agents are fakes. */
async function start(grading: { name: string; command: string }[], ask: Fake[], author: Fake[] | null) {
  const fake = (list: string) => (a: Fake) => ({ name: a.name, output: "claude-stream-json", command: `${fakeAgent(dir, `${list}-${a.name}`, a.steps)} ${gates} {prompt}` });
  const config: Record<string, unknown> = { timeout_seconds: 30, agents: grading };
  if (ask.length > 0) config.ask = { timeout_seconds: 30, agents: ask.map(fake("ask")) };
  if (author !== null) config.author = { timeout_seconds: 30, agents: author.map(fake("author")) };
  writeFileSync(join(dir, "bridge.json"), JSON.stringify(config));
  bridge = await startBridge({ ...process.env, SCHOOL_BRIDGE_TOKEN: TOKEN, SCHOOL_BRIDGE_CONFIG: join(dir, "bridge.json") });
  return bridge;
}

const post = (path: string, body: unknown, headers: Record<string, string> = auth, signal?: AbortSignal) =>
  fetch(bridge!.url + path, { method: "POST", headers, body: JSON.stringify(body), signal });

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

const b64 = (s: string) => Buffer.from(s).toString("base64");
const unb64 = (s: unknown) => Buffer.from(String(s), "base64").toString("utf8");
const COURSE = [{ path: "course.json", base64: b64('{"title":"SECRET-COURSE-TITLE"}\n') }, { path: "lessons/SECRET-LESSON-NAME.json", base64: b64('{"id":"SECRET-LESSON-ID"}\n') }];
const GUIDE = [{ path: "SKILL.md", base64: b64("# SECRET-SKILL-TEXT\n") }];
const request = (prompt = "Fix lesson one.") => ({ prompt, files: COURSE, guide: GUIDE });
const grader = (name: string, body: string) => ({ name, command: `${plainAgent(dir, name, body)} {prompt}` });
const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
const DONE: Step = { result: "Done." };

test("POST /author streams each step to the caller as NDJSON before the agent exits, then the course files and one end line", async () => {
  await start([grader("g", `echo '{"ok": true}'`)], [], [{ name: "claude", steps: [
    { sh: `pwd -P > "$1/cwd"` },
    { tool: "Read", input: { file_path: "course/course.json" } }, { gate: "1" },
    { sh: `printf '{"title":"Revised"}\\n' > course/course.json` },
    { tool: "Write", input: { file_path: "course/course.json", content: '{"title":"Revised"}' } }, { gate: "2" },
    DONE, { mark: "exited" },
  ] }]);
  const r = await post("/author", request());
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/x-ndjson");
  const got: [Record<string, unknown>, boolean][] = [];
  for await (const l of lines(r)) {
    got.push([l, reached("exited")]);
    if (l.type === "step") open(String(got.length));
  }
  expect(got.map(([l, exited]) => [l.type, exited])).toEqual([["step", false], ["step", false], ["files", true], ["end", true]]);
  expect(got.slice(0, 2).map(([l]) => l)).toEqual([{ type: "step", tool: "Read", path: "course/course.json" }, { type: "step", tool: "Write", path: "course/course.json" }]);
  const files = got[2]![0].files as { path: string; base64: string }[];
  expect(files.map((f) => [f.path, unb64(f.base64)])).toEqual([["course.json", '{"title":"Revised"}\n'], ["lessons/SECRET-LESSON-NAME.json", '{"id":"SECRET-LESSON-ID"}\n']]);
  expect(got[3]![0]).toEqual({ type: "end", status: "succeeded", agent: "claude", usage: USAGE, error: null, refusal: null, guide_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    attempts: [{ agent: "claude", status: "succeeded", ms: expect.any(Number), exit_code: 0, error: null, steps: 2 }] });
  expect(existsSync(readFileSync(join(gates, "cwd"), "utf8").trim())).toBe(false);
}, timeout(1));

test("a refused draft is an end line with the reason and the path, and no files line", async () => {
  await start([grader("g", "true")], [], [{ name: "claude", steps: [{ sh: "ln -s /etc/hosts course/lessons/hosts.json" }, DONE] }]);
  const out = await all(await post("/author", request()));
  expect(out).toEqual([{ type: "end", status: "refused", agent: "claude", usage: USAGE, error: expect.stringContaining("lessons/hosts.json"),
    refusal: { reason: "symlink", path: "lessons/hosts.json" }, guide_sha256: expect.stringMatching(/^[0-9a-f]{64}$/), attempts: [expect.objectContaining({ status: "refused" })] }]);
}, timeout(1));

test("an authoring request in progress delays neither a grading nor a question", async () => {
  await start([grader("g", `echo '{"ok": true}'`)], [{ name: "claude", steps: [{ delta: "Answered." }, { result: "Answered." }] }],
    [{ name: "claude", steps: [{ mark: "authoring" }, { gate: "finish-authoring" }, DONE] }]);
  const drafting = post("/author", request());
  await waitFor("authoring");
  expect(await (await post("/run", { prompt: "grade this", schema })).json()).toMatchObject({ status: "succeeded", output: { ok: true } });
  expect((await all(await post("/ask", { prompt: "a question" }))).at(-1)).toMatchObject({ type: "end", status: "succeeded" });
  expect(reached("finish-authoring")).toBe(false); // the draft is still being written
  open("finish-authoring");
  expect((await all(await drafting)).at(-1)).toMatchObject({ type: "end", status: "succeeded" });
}, timeout(1));

test("authoring requests wait for each other in their own queue", async () => {
  await start([grader("g", "true")], [], [{ name: "claude", steps: [{ sh: `n=$(ls "$1" | grep -c '^started') ; : > "$1/started-$n"` }, { gate: "go" }, DONE] }]);
  const first = post("/author", request());
  await waitFor("started-0");
  const second = post("/author", request());
  // An absence can only be watched for a while: long enough for a second agent to have started.
  await Bun.sleep(300);
  expect(reached("started-1")).toBe(false);
  open("go");
  for (const r of await Promise.all([first, second])) expect((await all(r)).at(-1)).toMatchObject({ status: "succeeded" });
  expect(reached("started-1")).toBe(true);
}, timeout(1));

test("no log line holds the prompt, a file's name or a file's content", async () => {
  await start([grader("g", "true")], [], [{ name: "claude", steps: [
    { tool: "Edit", input: { file_path: "course/lessons/SECRET-LESSON-NAME.json", old_string: "SECRET-OLD-TEXT", new_string: "SECRET-NEW-TEXT" } },
    { sh: `printf 'SECRET-WRITTEN-TEXT\\n' > course/reference/SECRET-REFERENCE-NAME.md` }, { stderr: "SECRET-STDERR-TEXT" }, DONE,
  ] }]);
  const out = await all(await post("/author", request("SECRET-PROMPT-TEXT")));
  expect(out.at(-1)).toMatchObject({ status: "succeeded" });
  bridge!.proc.kill();
  const { stdout } = await bridge!.output();
  bridge = null;
  const kinds = stdout.trim().split("\n").map((l) => JSON.parse(l).kind as string);
  expect(kinds.filter((k) => k.startsWith("bridge.author."))).toEqual(["bridge.author.start", "bridge.author.attempt", "bridge.author.end"]);
  expect(stdout.match(/SECRET-[A-Z-]+/g)).toBeNull();
}, timeout(1));

test("with no author list, POST /author is one failed end line naming the configuration file", async () => {
  await start([grader("g", "true")], [], null);
  expect(await all(await post("/author", request()))).toEqual([{ type: "end", status: "failed", agent: null, usage: null, refusal: null, guide_sha256: null, attempts: [],
    error: expect.stringContaining(join(dir, "bridge.json")) }]);
}, timeout(1));

test("POST /author refuses a request without the token, a body that is not JSON, a bad prompt, deadline or path, and runs nothing", async () => {
  await start([grader("g", "true")], [], [{ name: "claude", steps: [{ mark: "ran" }, DONE] }]);
  expect((await post("/author", request(), { "content-type": "application/json" })).status).toBe(401);
  expect((await post("/author", request(), { authorization: auth.authorization, "content-type": "text/plain" })).status).toBe(415);
  expect((await fetch(bridge!.url + "/author", { method: "POST", headers: auth, body: "{ not json" })).status).toBe(400);
  const bad = [
    {}, { ...request(), prompt: "" }, { ...request(), prompt: "x".repeat(200_001) }, { ...request(), deadline_ms: 0 },
    { ...request(), files: [{ path: "../escape", base64: "" }] }, { ...request(), files: [{ path: "/abs", base64: "" }] },
    { ...request(), guide: [{ path: "docs/x.md", base64: "" }] }, { ...request(), files: "course" },
  ];
  for (const body of bad) {
    const r = await post("/author", body);
    expect([JSON.stringify(body).slice(0, 50), r.status, ((await r.json()) as { status: string }).status]).toEqual([JSON.stringify(body).slice(0, 50), 400, "invalid"]);
  }
  expect((await fetch(bridge!.url + "/author", { headers: auth })).status).toBe(405);
  expect(reached("ran")).toBe(false);
}, timeout(1));

test("a caller that hangs up stops the agent, deletes its folder, and frees the author queue", async () => {
  await start([grader("g", "true")], [], [{ name: "claude", steps: [
    { sh: `pwd -P > "$1/cwd-$(ls "$1" | grep -c '^cwd')"` }, { tool: "Read", input: { file_path: "course/course.json" } }, { gate: "never" }, DONE,
  ] }]);
  const hangUp = new AbortController();
  const reader = lines(await post("/author", request(), auth, hangUp.signal));
  expect((await reader.next()).value).toEqual({ type: "step", tool: "Read", path: "course/course.json" });
  hangUp.abort();
  const next = post("/author", request());
  await waitFor("cwd-1");
  expect(existsSync(readFileSync(join(gates, "cwd-0"), "utf8").trim())).toBe(false);
  open("never");
  expect((await all(await next)).at(-1)).toMatchObject({ status: "succeeded", agent: "claude" });
}, timeout(1));
