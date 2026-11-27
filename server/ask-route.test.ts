// Asking about a passage over HTTP (RFC 6 §5.3, Figure 5.2 and Table 5.4; flyingrobots/school#227).
// School runs as a real process; a fake bridge in this process stands in for bridge/bridge.ts's
// POST /ask, streaming NDJSON `delta` lines and one `end` line, and contacts no model. The oracles
// are the issue's acceptance items: deltas arrive as NDJSON; the question and its exposure are in
// the record before the bridge is asked; a passage not in the lesson is refused (400); no quiz
// choice, `why` or model answer is in the prompt; an unchecked quote is dropped; a browser that
// disconnects still leaves a stored reply; with no bridge, a 503 with the reason.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "./blocks.ts";
import { AskLine, askRoute, type AskDeps } from "./ask.ts";
import { Conversation, type ReplyRecord } from "./core/model.ts";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const TOKEN = "ask-token-NEVER-SHOW-ME-0123";

const lesson: Block = {
  type: "page", id: "orbits", title: "Orbits", subtitle: "Why planets keep going", children: [
    { type: "prose", id: "p1", html: "<p>Nothing <em>stops</em> a planet &amp; nothing pushes it.</p>" },
    { type: "section", id: "s1", title: "Momentum", children: [
      { type: "quiz", id: "q1", q: "What keeps a planet moving?", why: "WHY-TEXT: nothing slows it down.", choices: [
        { id: "a", text: "CORRECT-CHOICE inertia", correct: true },
        { id: "b", text: "OTHER-CHOICE a push", correct: false },
      ] },
      { type: "explain", id: "e1", prompt: "How would you explain an orbit to a friend?", model: "MODEL-ANSWER: it falls and misses.",
        sources: [{ id: "src", title: "SOURCE-TITLE", text: "SOURCE-TEXT" }] },
    ] },
  ],
};
/** Every answer the lesson holds, which the prompt must never hold (RFC 6 Table 5.5). */
const ANSWERS = ["WHY-TEXT: nothing slows it down.", "CORRECT-CHOICE inertia", "OTHER-CHOICE a push", "MODEL-ANSWER: it falls and misses.", "SOURCE-TITLE", "SOURCE-TEXT"];

// ---- The fake bridge ----------------------------------------------------------------------------

type Asked = { authorization: string | null; prompt: string; deadline: unknown; before: Conversation[] };
const asked: Asked[] = [];
/** Gates a scenario's answer waits at, opened by its test. */
const gates = new Map<string, { wait: Promise<void>; open: () => void }>();
function gate(name: string) {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  gates.set(name, { wait, open });
  return open;
}
const end = (status: "succeeded" | "failed", error: string | null = null) => ({
  type: "end", status, agent: "fake-claude", error, attempts: [],
  usage: status === "succeeded" ? { input_tokens: 120, output_tokens: 30, cache_creation_input_tokens: null, cache_read_input_tokens: null } : null,
});
const delta = (text: string) => ({ type: "delta", text });
const SOURCES = (quotes: { source_id: string; quote: string }[]) => `\n\n<sources>\n${JSON.stringify(quotes)}\n</sources>`;

/** What the fake agent answers, by the last `[scenario]` tag in the prompt's question. */
const SCENARIOS: Record<string, (string | Record<string, unknown>)[]> = {
  golden: [delta("An orbit is "), "golden", delta("falling while moving sideways.\n\n<sou"),
    delta(`rces>\n${JSON.stringify([{ source_id: "orbits", quote: "Nothing  stops a planet" }])}\n</sources>`), end("succeeded")],
  unchecked: [delta("Planets coast." + SOURCES([{ source_id: "orbits", quote: "nothing pushes it" }, { source_id: "orbits", quote: "Planets are pushed by angels" }, { source_id: "nowhere", quote: "Nothing" }])), end("succeeded")],
  disconnect: [delta("First part. "), "disconnect", delta("Second part."), end("succeeded")],
  gone: [delta("First part. "), "gone", delta("Second part."), end("succeeded")],
  failing: [delta("Half an"), end("failed", "timed out after 90 s")],
  plain: [delta("Plain answer."), end("succeeded")],
};

let school: Started;
let bare: Started; // no bridge configured
let away: Started; // a bridge that is not listening
let root = "";
const bridge = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/ask") return Response.json({ status: "not found" }, { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ status: "unauthorised" }, { status: 401 });
    const body = await req.json() as { prompt: string; deadline_ms?: unknown };
    // What School's record holds at the moment the bridge is asked, read back through School.
    const before = Conversation.array().parse(await (await fetch(`${school.url}/api/courses/astro/lessons/orbits/conversations`)).json());
    asked.push({ authorization: req.headers.get("authorization"), prompt: body.prompt, deadline: body.deadline_ms, before });
    const tags = [...body.prompt.matchAll(/\[(\w+)\]/g)];
    const steps = SCENARIOS[tags.at(-1)?.[1] ?? "plain"] ?? SCENARIOS.plain!;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({
      async start(out) {
        for (const s of steps) {
          if (typeof s === "string") await gates.get(s)?.wait;
          else out.enqueue(encoder.encode(JSON.stringify(s) + "\n"));
        }
        out.close();
      },
    }), { headers: { "content-type": "application/x-ndjson" } });
  },
});

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-ask-"));
  mkdirSync(join(root, "course", "lessons"), { recursive: true });
  writeFileSync(join(root, "course", "course.json"), JSON.stringify({ title: "Astronomy" }));
  writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify(lesson));
  cpSync(join(root, "course"), join(root, "wild"), { recursive: true });
  const env = (state: string, extra: Record<string, string | undefined>) => ({
    ...process.env, SCHOOL_COURSE: undefined, SCHOOL_COURSES: `astro=${join(root, "course")}`, SCHOOL_UNTRUSTED_COURSES: `wild=${join(root, "wild")}`,
    SCHOOL_STATE: join(root, state), SCHOOL_DATABASE_URL: `pglite:${join(root, state, "record")}`, HOST: "127.0.0.1",
    SCHOOL_BRIDGE_URL: undefined, SCHOOL_BRIDGE_TOKEN: undefined, ...extra,
  });
  school = await startSchool(env("school", { SCHOOL_BRIDGE_URL: bridge.url.href.replace(/\/$/, ""), SCHOOL_BRIDGE_TOKEN: TOKEN }));
  bare = await startSchool(env("bare", {}));
  const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = closed.port;
  closed.stop(true);
  away = await startSchool(env("away", { SCHOOL_BRIDGE_URL: `http://127.0.0.1:${port}`, SCHOOL_BRIDGE_TOKEN: TOKEN }));
}, timeout(3) + 20_000);

afterAll(async () => {
  for (const s of [school, bare, away]) { s?.proc.kill(); await s?.proc.exited; }
  bridge.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

// ---- Helpers ------------------------------------------------------------------------------------

const post = (s: Started, path: string, body: unknown, signal?: AbortSignal) =>
  fetch(s.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });

/** The encounter the lesson page would open, tracking aid. */
async function encounter(s: Started, course = "astro"): Promise<string> {
  const r = await fetch(`${s.url}/api/courses/${course}/lessons/orbits?aid=1`);
  expect(r.status).toBe(200);
  return ((await r.json()) as { encounterId: string }).encounterId;
}

/** A first question about a passage of the lesson, with fresh ids. */
async function question(s: Started, text: string, over: Record<string, unknown> = {}) {
  return { course: "astro", lesson: "orbits", conversationId: crypto.randomUUID(), questionId: crypto.randomUUID(), encounterId: await encounter(s),
    blockId: "p1", passage: "Nothing stops a planet", text, ...over };
}

async function conversations(s: Started, course = "astro"): Promise<Conversation[]> {
  const r = await fetch(`${s.url}/api/courses/${course}/lessons/orbits/conversations`);
  expect(r.status).toBe(200);
  return Conversation.array().parse(await r.json());
}
const findQuestion = (cs: Conversation[], questionId: string) => cs.flatMap((c) => c.questions).find((q) => q.questionId === questionId);

/** Reads NDJSON lines from a response body as they arrive; each is checked against AskLine. */
function lines(r: Response) {
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let held = "";
  return {
    reader,
    async next(): Promise<AskLine | null> {
      for (;;) {
        const at = held.indexOf("\n");
        if (at !== -1) {
          const line = held.slice(0, at);
          held = held.slice(at + 1);
          return AskLine.parse(JSON.parse(line));
        }
        const { done, value } = await reader.read();
        if (done) return held.trim() === "" ? null : AskLine.parse(JSON.parse(held));
        held += decoder.decode(value, { stream: true });
      }
    },
    async rest(): Promise<AskLine[]> {
      const all: AskLine[] = [];
      for (let l = await this.next(); l !== null; l = await this.next()) all.push(l);
      return all;
    },
  };
}

/** `p`, or a failure naming `what` once `ms` have passed, so a held stream fails its own test instead of timing it out. */
async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`${what} within ${ms} ms`)), ms); });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Waits until School's record holds a reply to `questionId`, for at most `ms`; a condition, not a sleep. */
async function replyOf(s: Started, questionId: string, ms = 5_000) {
  const until = Date.now() + ms;
  for (;;) {
    const q = findQuestion(await conversations(s), questionId);
    if (q?.reply != null) return q.reply;
    if (Date.now() > until) throw new Error(`no reply to question ${questionId} was stored within ${ms} ms`);
    await Bun.sleep(25);
  }
}

// ---- The cases ----------------------------------------------------------------------------------

describe("POST /api/ask", () => {
  test("golden: the answer streams as NDJSON deltas while the agent writes, then its checked sources, and the reply is stored", async () => {
    const open = gate("golden");
    const q = await question(school, "[golden] Why doesn't it slow down?");
    const r = await post(school, "/api/ask", q);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toStartWith("application/x-ndjson");
    const read = lines(r);
    expect(await read.next()).toEqual({ type: "stored", conversationId: q.conversationId, questionId: q.questionId });
    // The first delta arrives while the agent is held at its gate: proxied, not buffered.
    try {
      expect(await within(3_000, read.next(), "no delta arrived while the agent was held at its gate")).toEqual({ type: "delta", text: "An orbit is " });
    } finally {
      open();
    }
    const rest = await read.rest();
    const text = rest.flatMap((l) => (l.type === "delta" ? [l.text] : [])).join("");
    expect(text).toBe("falling while moving sideways.\n\n");
    expect(rest.filter((l) => l.type !== "delta")).toEqual([
      { type: "sources", sources: [{ sourceId: "orbits", title: "Orbits", quote: "Nothing  stops a planet" }] },
      { type: "done", agent: "fake-claude" },
    ]);
    const reply = findQuestion(await conversations(school), q.questionId)?.reply;
    expect(reply).toMatchObject({
      status: "succeeded", text: "An orbit is falling while moving sideways.", error: null, agent: "fake-claude",
      sources: [{ sourceId: "orbits", quote: "Nothing  stops a planet", checked: true }], usage: { input_tokens: 120, output_tokens: 30 },
    });
    expect(asked.at(-1)!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("the question and its ai-help exposure are in the record before the bridge is asked", async () => {
    const q = await question(school, "[plain] What does 'stops' mean here?");
    await (await post(school, "/api/ask", q)).text();
    const seen = asked.at(-1)!;
    expect(seen.prompt).toContain("What does 'stops' mean here?");
    const before = findQuestion(seen.before, q.questionId);
    expect(before).toMatchObject({ questionId: q.questionId, encounterId: q.encounterId, text: "[plain] What does 'stops' mean here?", reply: null });
    // exposureSeq references the question's own exposure (questions_exposure_encounter), before it in the record.
    expect(before!.exposureSeq).toBeLessThan(before!.seq);
    expect(seen.before.find((c) => c.conversationId === q.conversationId)).toMatchObject({ blockId: "p1", passage: "Nothing stops a planet" });
  });

  test("a passage not in the lesson is refused (400) and nothing is stored or asked", async () => {
    const count = asked.length;
    for (const over of [{ passage: "Planets are pushed by angels" }, { blockId: "q1", passage: "CORRECT-CHOICE inertia" }, { passage: "Nothing <em>stops</em>" }, { blockId: "nowhere" }]) {
      const q = await question(school, "[plain] Is this right?", over);
      const r = await post(school, "/api/ask", q);
      expect([JSON.stringify(over), r.status]).toEqual([JSON.stringify(over), 400]);
      expect(typeof (await r.json()).error).toBe("string");
      expect(findQuestion(await conversations(school), q.questionId)).toBeUndefined();
    }
    expect(asked.length).toBe(count);
  });

  test("no quiz choice, why or model answer is in the prompt, even for a passage in a quiz", async () => {
    await (await post(school, "/api/ask", await question(school, "[plain] Which one is it?", { blockId: "q1", passage: "What keeps a planet moving?" }))).text();
    const { prompt } = asked.at(-1)!;
    expect(prompt).toContain("What keeps a planet moving?");
    for (const a of ANSWERS) expect([a, prompt.includes(a)]).toEqual([a, false]);
  });

  test("an unchecked quote is dropped from the sources shown, and stored as unchecked", async () => {
    const q = await question(school, "[unchecked] Why do they coast?");
    const all = await lines(await post(school, "/api/ask", q)).rest();
    expect(all.find((l) => l.type === "sources")).toEqual({ type: "sources", sources: [{ sourceId: "orbits", title: "Orbits", quote: "nothing pushes it" }] });
    const reply = findQuestion(await conversations(school), q.questionId)?.reply;
    expect(reply?.text).toBe("Planets coast.");
    expect(reply?.sources).toEqual([
      { sourceId: "orbits", quote: "nothing pushes it", checked: true },
      { sourceId: "orbits", quote: "Planets are pushed by angels", checked: false },
      { sourceId: "nowhere", quote: "Nothing", checked: false },
    ]);
  });

  test("a browser that disconnects mid-answer still leaves the whole reply stored", async () => {
    const open = gate("disconnect");
    const q = await question(school, "[disconnect] Tell me more?");
    const browser = new AbortController();
    const r = await post(school, "/api/ask", q, browser.signal);
    const read = lines(r);
    try {
      expect((await read.next())?.type).toBe("stored");
      expect(await within(3_000, read.next(), "no delta arrived while the agent was held at its gate")).toEqual({ type: "delta", text: "First part. " });
      browser.abort();
      await read.reader.cancel().catch(() => {});
    } finally {
      open();
    }
    const reply = await replyOf(school, q.questionId);
    expect(reply).toMatchObject({ status: "succeeded", text: "First part. Second part.", agent: "fake-claude" });
  });

  // Across processes, whether School notices the browser has gone before the bridge's last line
  // arrives is a race this test cannot hold. In process, cancelling the stream School answers with
  // is exactly what a browser going away does to it, at a moment the test chooses.
  test("in process: a browser that goes away mid-answer leaves the bridge's answer read to its end and stored", async () => {
    const open = gate("gone");
    const [conversationId, questionId, encounterId] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const at = new Date(0).toISOString();
    let stored!: (r: ReplyRecord) => void;
    const reply = new Promise<ReplyRecord>((r) => { stored = r; });
    const deps: AskDeps = {
      school: {
        ask: async () => ({ status: "stored" }),
        recordReply: async (r) => { stored(r); return { status: "stored" }; },
        lessonConversations: async () => [{ conversationId, blockId: "p1", passage: "Nothing stops a planet", seq: 1, at,
          questions: [{ questionId, encounterId, text: "[gone] And after?", seq: 3, exposureSeq: 2, at, reply: null }] }],
      },
      lesson: async () => ({ page: lesson, references: [] }),
      bridge: () => ({ url: bridge.url.href.replace(/\/$/, ""), token: TOKEN, deadlineMs: 10_000 }),
      noBridge: () => "no bridge",
      log: () => {},
    };
    const r = await askRoute(deps, { course: "astro", lesson: "orbits", conversationId, questionId, encounterId, blockId: "p1", passage: "Nothing stops a planet", text: "[gone] And after?" });
    const read = lines(r);
    try {
      expect((await read.next())?.type).toBe("stored");
      expect(await within(3_000, read.next(), "no delta arrived while the agent was held at its gate")).toEqual({ type: "delta", text: "First part. " });
      await read.reader.cancel();
    } finally {
      open();
    }
    expect(await within(3_000, reply, "no reply was stored")).toMatchObject({ status: "succeeded", text: "First part. Second part.", agent: "fake-claude" });
  });

  test("an answer that fails after its first words ends with a failed line, and is stored failed with what was shown", async () => {
    const q = await question(school, "[failing] And then?");
    const all = await lines(await post(school, "/api/ask", q)).rest();
    expect(all.map((l) => l.type)).toEqual(["stored", "delta", "failed"]);
    expect(all.at(-1)).toEqual({ type: "failed", error: "timed out after 90 s" });
    expect(findQuestion(await conversations(school), q.questionId)?.reply).toMatchObject({ status: "failed", text: "Half an", error: "timed out after 90 s", agent: "fake-claude" });
  });

  test("a follow-up question sends the conversation's passage and its earlier turns from the record", async () => {
    const first = await question(school, "[plain] FIRST-QUESTION about stopping?");
    await (await post(school, "/api/ask", first)).text();
    const follow = { ...first, questionId: crypto.randomUUID(), blockId: null, passage: null, text: "[plain] SECOND-QUESTION, and then?" };
    const all = await lines(await post(school, "/api/ask", follow)).rest();
    expect(all.at(-1)).toEqual({ type: "done", agent: "fake-claude" });
    const { prompt } = asked.at(-1)!;
    for (const s of ["FIRST-QUESTION about stopping?", "Plain answer.", "SECOND-QUESTION, and then?", "Nothing stops a planet"]) expect([s, prompt.includes(s)]).toEqual([s, true]);
    const c = (await conversations(school)).find((x) => x.conversationId === first.conversationId)!;
    expect(c.questions.map((x) => x.questionId)).toEqual([first.questionId, follow.questionId]);
  });

  test("a resent question is not asked again; another question under its id is a conflict (409)", async () => {
    const q = await question(school, "[plain] Once only?");
    await (await post(school, "/api/ask", q)).text();
    const count = asked.length;
    expect((await post(school, "/api/ask", q)).status).toBe(409);
    expect((await post(school, "/api/ask", { ...q, text: "[plain] Something else?" })).status).toBe(409);
    expect(asked.length).toBe(count);
  });

  test("with no bridge, a 503 with the reason, and nothing stored", async () => {
    const q = await question(bare, "[plain] Anyone there?");
    const r = await post(bare, "/api/ask", q);
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error).toContain("bridge");
    expect(body.error).toContain("Settings");
    expect(await conversations(bare)).toEqual([]);
  });

  test("with a bridge that cannot be reached, a 503 with the reason; the question is stored first, and its reply as failed", async () => {
    const q = await question(away, "[plain] Anyone there?");
    const r = await post(away, "/api/ask", q);
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error).toContain("could not be reached");
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(findQuestion(await conversations(away), q.questionId)?.reply).toMatchObject({ status: "failed", text: "" });
  });

  test("a course in safe mode is not asked about (403), and nothing is stored", async () => {
    const count = asked.length;
    const q = await question(school, "[plain] Untrusted?", { course: "wild", encounterId: await encounter(school, "wild") });
    const r = await post(school, "/api/ask", q);
    expect(r.status).toBe(403);
    expect(typeof (await r.json()).error).toBe("string");
    expect(await conversations(school, "wild")).toEqual([]);
    expect(asked.length).toBe(count);
  });

  test("a malformed request, an unknown course or lesson, and an untracked encounter are refused", async () => {
    const count = asked.length;
    expect((await post(school, "/api/ask", { text: "hello" })).status).toBe(400);
    expect((await post(school, "/api/ask", await question(school, "[plain] x?", { course: "nope" }))).status).toBe(404);
    expect((await post(school, "/api/ask", await question(school, "[plain] x?", { lesson: "nope" }))).status).toBe(404);
    const untracked = ((await (await fetch(`${school.url}/api/courses/astro/lessons/orbits`)).json()) as { encounterId: string }).encounterId;
    expect((await post(school, "/api/ask", await question(school, "[plain] x?", { encounterId: untracked }))).status).toBe(400);
    expect((await fetch(school.url + "/api/ask", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect(asked.length).toBe(count);
  });
});

describe("POST /api/ask in process, at the bridge's edges", () => {
  /** Route dependencies over a record that stores every question and hands back `filed` as the lesson's conversations. */
  function inProcess(over: Partial<AskDeps>, filed: (q: { conversationId: string; questionId: string; encounterId: string }) => Conversation[]) {
    const replies: ReplyRecord[] = [];
    const ids = { conversationId: crypto.randomUUID(), questionId: crypto.randomUUID(), encounterId: crypto.randomUUID() };
    const deps: AskDeps = {
      school: { ask: async () => ({ status: "stored" }), recordReply: async (r) => { replies.push(r); return { status: "stored" }; }, lessonConversations: async () => filed(ids) },
      lesson: async () => ({ page: lesson, references: [] }),
      bridge: () => ({ url: bridge.url.href.replace(/\/$/, ""), token: TOKEN, deadlineMs: 10_000 }),
      noBridge: () => "no bridge",
      log: () => {},
      ...over,
    };
    const body = { course: "astro", lesson: "orbits", ...ids, blockId: "p1", passage: "Nothing stops a planet", text: "[plain] Edges?" };
    return { deps, body, replies };
  }
  const at = new Date(0).toISOString();
  const filedHere = (q: { conversationId: string; questionId: string; encounterId: string }): Conversation[] =>
    [{ conversationId: q.conversationId, blockId: "p1", passage: "Nothing stops a planet", seq: 1, at, questions: [{ ...q, text: "[plain] Edges?", seq: 3, exposureSeq: 2, at, reply: null }] }];

  test("a question the record files under another lesson is not answered, and its reply is stored as failed", async () => {
    const count = asked.length;
    const { deps, body, replies } = inProcess({}, () => []);
    const r = await askRoute(deps, body);
    expect(r.status).toBe(400);
    expect(asked.length).toBe(count);
    expect(replies).toMatchObject([{ questionId: body.questionId, status: "failed", text: "" }]);
  });

  test("a bridge that refuses School's token is a 502 in words, and the reply is stored as failed", async () => {
    const { deps, body, replies } = inProcess({ bridge: () => ({ url: bridge.url.href.replace(/\/$/, ""), token: "another-token-0123456", deadlineMs: 10_000 }) }, filedHere);
    const r = await askRoute(deps, body);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toContain("token");
    expect(replies).toMatchObject([{ status: "failed" }]);
  });

  test("a bridge older than asking (no POST /ask) is a 503 in words, and the reply is stored as failed", async () => {
    const { deps, body, replies } = inProcess({ bridge: () => ({ url: `${bridge.url.href.replace(/\/$/, "")}/old`, token: TOKEN, deadlineMs: 10_000 }) }, filedHere);
    const r = await askRoute(deps, body);
    expect(r.status).toBe(503);
    expect((await r.json()).error).toContain("older");
    expect(replies).toMatchObject([{ status: "failed" }]);
  });
});

describe("GET /api/courses/:c/lessons/:id/conversations", () => {
  test("an unknown course is a 404; a lesson with no conversations is an empty list", async () => {
    expect((await fetch(`${school.url}/api/courses/nope/lessons/orbits/conversations`)).status).toBe(404);
    const r = await fetch(`${bare.url}/api/courses/astro/lessons/orbits/conversations`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.json()).toEqual([]);
  });
});
