// Reading aloud (flyingrobots/school#175), on the server: what School speaks, and the proxy to the
// bridge. The text is built here, from the lesson as written or the latest feedback; the browser
// never sends any. Oracles are the issue's acceptance items: a lesson's spoken text includes its
// question and excludes every correct choice, `why` and model answer; with no bridge it is a 503
// in words; the proxy sends the bridge its token, and the token is never shown.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block } from "./blocks.ts";
import { openDatabase } from "./adapters/database.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import { feedbackSpeech, htmlText, lessonSpeech } from "./speak.ts";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const TOKEN = "speak-token-NEVER-SHOW-ME";
const ID = `utt_${"ab".repeat(16)}`;

const lesson: Block = {
  type: "page", id: "orbits", title: "Orbits", subtitle: "Why planets keep going", children: [
    { type: "prose", id: "p1", html: "<p>Nothing <em>stops</em> a planet &amp; nothing pushes it.</p><script>NOT-SPOKEN-SCRIPT</script>" },
    { type: "section", id: "s1", title: "Momentum", children: [
      { type: "quiz", id: "q1", q: "What keeps a planet moving?", why: "WHY-TEXT: nothing slows it down.", choices: [
        { id: "a", text: "CORRECT-CHOICE inertia", correct: true },
        { id: "b", text: "OTHER-CHOICE a push", correct: false },
      ] },
      { type: "aside", id: "a1", html: "<p>Newton&#39;s first law.</p>" },
      { type: "explain", id: "e1", prompt: "How would you explain an orbit to a friend?", model: "MODEL-ANSWER: it falls and misses.",
        sources: [{ id: "src", title: "SOURCE-TITLE", text: "SOURCE-TEXT" }] },
      { type: "nest", id: "n1", root: { label: "NEST-LABEL", atoms: ["NEST-ATOM"], children: [] } },
    ] },
    { type: "card", id: "c1", html: "<p>Look up tonight.</p>" },
  ],
};

const findings = {
  insufficient_evidence: false,
  summary: "Good start: you have the core idea.",
  contradictions: [{ source_id: "src", quote: "CONTRADICTION-QUOTE", note: "CONTRADICTION-NOTE" }],
  fidelity: { verdict: "meets" as const, note: "Right idea." },
  completeness: { verdict: "misses" as const, note: "One more step." },
  accessibility: { verdict: "partly" as const, note: "Mostly plain." },
};

describe("what School speaks", () => {
  test("speak-lesson: the title, subtitle, section titles, prose and each question, and never a choice, a why, a model answer or a source", () => {
    const text = lessonSpeech(lesson);
    for (const said of ["# Orbits", "Why planets keep going", "## Momentum", "Nothing stops a planet & nothing pushes it.", "What keeps a planet moving?",
      "Newton's first law.", "How would you explain an orbit to a friend?", "Look up tonight."]) expect(text).toContain(said);
    for (const never of ["CORRECT-CHOICE", "OTHER-CHOICE", "WHY-TEXT", "MODEL-ANSWER", "SOURCE-TITLE", "SOURCE-TEXT", "NOT-SPOKEN-SCRIPT", "NEST-LABEL", "NEST-ATOM", "<", "&amp;"]) {
      expect([never, text.includes(never)]).toEqual([never, false]);
    }
    // In the order the page shows them.
    const order = ["Orbits", "Nothing stops", "Momentum", "What keeps", "Newton", "How would you", "Look up"].map((s) => text.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("speak-html: tags are dropped, blocks become paragraphs, entities are decoded, and scripts, styles and drawings are not read", () => {
    expect(htmlText("<p>One</p><p>Two&nbsp;&lt;three&gt; &#x41;&#66;</p>")).toBe("One\n\nTwo <three> AB");
    expect(htmlText("<ul><li>a</li><li>b</li></ul><style>x{}</style><svg><text>DRAWN</text></svg>")).toBe("a\n\nb");
  });

  test("speak-feedback: the lesson, the prompt, the summary and each criterion in words, and never a contradiction's quote", () => {
    const text = feedbackSpeech({ lessonTitle: "Orbits", prompt: "How would you explain an orbit?", findings });
    for (const said of ["Feedback on your explanation of Orbits", "How would you explain an orbit?", "Good start: you have the core idea.",
      "Fidelity: Meets. Right idea.", "Completeness: Not yet. One more step.", "Accessibility: Partly. Mostly plain."]) expect(text).toContain(said);
    expect(text).not.toContain("CONTRADICTION");
    expect(text).not.toContain("misses");
  });
});

// ---- Over HTTP, through a fake bridge -----------------------------------------------------------

type Seen = { method: string; path: string; authorization: string | null; range: string | null; body: string };
const seen: Seen[] = [];
let bridgeReply: { status: number; body: unknown } | null = null;
const WAV = new Uint8Array(64).map((_, i) => i);
let bridge: ReturnType<typeof Bun.serve>;
let root = "";
let school: Started;
let bare: Started; // no bridge configured
let away: Started; // a bridge that is not listening

beforeAll(async () => {
  bridge = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      seen.push({ method: req.method, path: u.pathname, authorization: req.headers.get("authorization"), range: req.headers.get("range"), body: await req.text() });
      if (bridgeReply !== null) return Response.json(bridgeReply.body, { status: bridgeReply.status });
      if (u.pathname === "/speak") return Response.json({ id: ID, state: "Queued", segments: 2 });
      if (u.pathname === `/speak/${ID}`) return Response.json({ id: ID, state: "Synthesizing", error: null, segments: [{ index: 0, ready: true, durationMs: 900 }, { index: 1, ready: false, durationMs: null }] });
      if (u.pathname === `/speak/${ID}/cancel`) return Response.json({ id: ID, state: "Cancelled" });
      if (u.pathname === `/speak/${ID}/segments/0`) {
        const range = req.headers.get("range");
        if (range === "bytes=0-3") return new Response(WAV.slice(0, 4), { status: 206, headers: { "content-type": "audio/wav", "content-range": `bytes 0-3/${WAV.length}`, "accept-ranges": "bytes", "x-bridge-secret": TOKEN } });
        return new Response(WAV, { headers: { "content-type": "audio/wav", "accept-ranges": "bytes" } });
      }
      return Response.json({ status: "forbidden", error: "The bridge serves only speech it submitted." }, { status: 403 });
    },
  });
  root = mkdtempSync(join(tmpdir(), "school-speak-"));
  mkdirSync(join(root, "course", "lessons"), { recursive: true });
  writeFileSync(join(root, "course", "course.json"), JSON.stringify({ title: "Astronomy" }));
  writeFileSync(join(root, "course", "lessons", "0001.json"), JSON.stringify(lesson));
  // The latest feedback: an explanation of e1, graded.
  const seed = async (dir: string) => {
    const db = await openDatabase({ driver: "pglite", dir });
    const r = postgresRecord(db.sql);
    const now = new Date().toISOString();
    const e = await r.openEncounter({ course: "astro", lesson: "orbits", page: lesson as never, now, aidTracking: 1 });
    const submissionId = crypto.randomUUID();
    await r.saveExplanation({ submissionId, encounterId: e.id, blockId: "e1", text: "It falls.", ms: 10 }, now);
    await r.recordGrading({ status: "succeeded", error: null, submissionId, rubricVersion: "r", promptVersion: "p", adapter: "test", model: "claude", sources: [], raw: "{}",
      findings: { ...findings, contradictions: findings.contradictions.map((c) => ({ ...c, quote_verified: false })) } }, now);
    await db.close();
  };
  await seed(join(root, "graded", "record"));
  const env = (state: string, extra: Record<string, string | undefined>) => ({
    ...process.env, SCHOOL_COURSE: undefined, SCHOOL_COURSES: `astro=${join(root, "course")}`, SCHOOL_STATE: join(root, state),
    SCHOOL_DATABASE_URL: `pglite:${join(root, state, "record")}`, HOST: "127.0.0.1", SCHOOL_BRIDGE_URL: undefined, SCHOOL_BRIDGE_TOKEN: undefined, ...extra,
  });
  school = await startSchool(env("graded", { SCHOOL_BRIDGE_URL: bridge.url.href.replace(/\/$/, ""), SCHOOL_BRIDGE_TOKEN: TOKEN }));
  bare = await startSchool(env("bare", {}));
  const closed = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = closed.port;
  closed.stop(true);
  away = await startSchool(env("away", { SCHOOL_BRIDGE_URL: `http://127.0.0.1:${port}`, SCHOOL_BRIDGE_TOKEN: TOKEN }));
}, timeout(3) + 20_000);

afterAll(async () => {
  for (const s of [school, bare, away]) { s?.proc.kill(); await s?.proc.exited; }
  bridge?.stop(true);
  if (root) rmSync(root, { recursive: true, force: true });
});

const post = (s: Started, path: string, body: unknown) =>
  fetch(s.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** Every response's headers and body as text, so a test can check the token is in none of them. */
async function shown(r: Response): Promise<string> {
  return JSON.stringify([...r.headers]) + (await r.clone().text());
}

describe("POST /api/speak", () => {
  test("speak-lesson-http: the server builds the lesson's text, sends it to the bridge with its token, and answers with the utterance", async () => {
    seen.length = 0;
    const r = await post(school, "/api/speak", { course: "astro", lesson: "orbits" });
    expect(r.status).toBe(200);
    expect(await shown(r)).not.toContain(TOKEN);
    expect(await r.json()).toEqual({ id: ID, state: "Queued", segments: 2 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/speak", authorization: `Bearer ${TOKEN}` });
    const { text } = JSON.parse(seen[0]!.body);
    expect(text).toBe(lessonSpeech(lesson));
    expect(text).toContain("What keeps a planet moving?");
    for (const never of ["CORRECT-CHOICE", "WHY-TEXT", "MODEL-ANSWER"]) expect(text).not.toContain(never);
  });

  test("speak-feedback-http: { feedback: true } speaks the latest feedback", async () => {
    seen.length = 0;
    const r = await post(school, "/api/speak", { feedback: true });
    expect(r.status).toBe(200);
    const { text } = JSON.parse(seen[0]!.body);
    expect(text).toBe(feedbackSpeech({ lessonTitle: "Orbits", prompt: "How would you explain an orbit to a friend?", findings }));
  });

  test("speak-no-text: the browser cannot send text, and an unknown lesson or a missing feedback is a 404", async () => {
    seen.length = 0;
    for (const body of [{ text: "Say this." }, { course: "astro", lesson: "orbits", text: "Say this." }, { feedback: false }, {}, null]) {
      expect([JSON.stringify(body), (await post(school, "/api/speak", body)).status]).toEqual([JSON.stringify(body), 400]);
    }
    expect((await post(school, "/api/speak", { course: "astro", lesson: "nope" })).status).toBe(404);
    expect((await post(school, "/api/speak", { course: "nope", lesson: "orbits" })).status).toBe(404);
    expect((await post(bare, "/api/speak", { feedback: true })).status).toBe(404);
    expect((await fetch(school.url + "/api/speak", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
    expect(seen).toEqual([]);
  });

  test("speak-503: with no bridge, or a bridge that cannot be reached, every speak route is a 503 in words", async () => {
    for (const s of [bare, away]) {
      const rs = [
        await post(s, "/api/speak", { course: "astro", lesson: "orbits" }),
        await fetch(`${s.url}/api/speak/${ID}`),
        await fetch(`${s.url}/api/speak/${ID}/segments/0`),
        await post(s, `/api/speak/${ID}/cancel`, {}),
      ];
      for (const r of rs) {
        expect(r.status).toBe(503);
        const body = await r.json();
        expect(body.error).toMatch(/bridge/);
        expect(JSON.stringify(body)).not.toContain(TOKEN);
      }
    }
    const none = await (await post(bare, "/api/speak", { course: "astro", lesson: "orbits" })).json();
    expect(none.error).toContain("Settings");
  });

  test("speak-daemon-503: the bridge's own 503 (no AI-TTS) reaches the browser with its reason", async () => {
    bridgeReply = { status: 503, body: { status: "unavailable", error: "AI-TTS isn't running: its socket is missing. Start AI-TTS, then try again." } };
    try {
      const r = await post(school, "/api/speak", { course: "astro", lesson: "orbits" });
      expect(r.status).toBe(503);
      expect((await r.json()).error).toContain("AI-TTS isn't running");
    } finally {
      bridgeReply = null;
    }
  });

  test("speak-old-bridge: a bridge from before reading aloud, with no /speak route, is a 503 asking for it to be updated", async () => {
    bridgeReply = { status: 404, body: { status: "not found" } };
    try {
      const r = await post(school, "/api/speak", { course: "astro", lesson: "orbits" });
      expect(r.status).toBe(503);
      expect((await r.json()).error).toContain("Update and restart the bridge");
    } finally {
      bridgeReply = null;
    }
  });
});

describe("the proxy", () => {
  test("speak-progress-http: GET /api/speak/:id is the bridge's progress, fetched with the token", async () => {
    seen.length = 0;
    const r = await fetch(`${school.url}/api/speak/${ID}`);
    expect(r.status).toBe(200);
    expect(await shown(r)).not.toContain(TOKEN);
    expect(await r.json()).toEqual({ id: ID, state: "Synthesizing", error: null, segments: [{ index: 0, ready: true, durationMs: 900 }, { index: 1, ready: false, durationMs: null }] });
    expect(seen[0]).toMatchObject({ method: "GET", path: `/speak/${ID}`, authorization: `Bearer ${TOKEN}` });
  });

  test("speak-segment-http: a segment's WAV is passed through, with the browser's byte range, and none of the bridge's other headers", async () => {
    seen.length = 0;
    const whole = await fetch(`${school.url}/api/speak/${ID}/segments/0`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/wav");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(WAV);
    const part = await fetch(`${school.url}/api/speak/${ID}/segments/0`, { headers: { range: "bytes=0-3" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-3/${WAV.length}`);
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(part.headers.get("x-bridge-secret")).toBeNull();
    expect(await shown(part)).not.toContain(TOKEN);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(WAV.slice(0, 4));
    expect(seen.map((s) => [s.path, s.authorization, s.range])).toEqual([[`/speak/${ID}/segments/0`, `Bearer ${TOKEN}`, null], [`/speak/${ID}/segments/0`, `Bearer ${TOKEN}`, "bytes=0-3"]]);
  });

  test("speak-cancel-http: POST /api/speak/:id/cancel cancels at the bridge", async () => {
    seen.length = 0;
    const r = await post(school, `/api/speak/${ID}/cancel`, {});
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: ID, state: "Cancelled" });
    expect(seen[0]).toMatchObject({ method: "POST", path: `/speak/${ID}/cancel`, authorization: `Bearer ${TOKEN}` });
  });

  test("speak-ids: an id that is not an utterance's is a 400 and never reaches the bridge; the bridge's 403 is passed on", async () => {
    seen.length = 0;
    for (const path of ["/api/speak/nope", "/api/speak/utt_XYZ", `/api/speak/${ID}/segments/-1`, `/api/speak/${ID}/segments/a`]) {
      expect([path, (await fetch(school.url + path)).status]).toEqual([path, 400]);
    }
    expect(seen).toEqual([]);
    const other = `utt_${"cd".repeat(16)}`;
    expect((await fetch(`${school.url}/api/speak/${other}`)).status).toBe(403);
  });

  test("speak-token: the token is never in the server's output", async () => {
    await post(school, "/api/speak", { course: "astro", lesson: "orbits" });
    school.proc.kill();
    const { stdout, stderr } = await school.output();
    expect(stdout + stderr).not.toContain(TOKEN);
    school = await startSchool({ ...process.env, SCHOOL_COURSE: undefined, SCHOOL_COURSES: `astro=${join(root, "course")}`, SCHOOL_STATE: join(root, "graded"),
      SCHOOL_DATABASE_URL: `pglite:${join(root, "graded", "record")}`, HOST: "127.0.0.1", SCHOOL_BRIDGE_URL: bridge.url.href.replace(/\/$/, ""), SCHOOL_BRIDGE_TOKEN: TOKEN });
  }, timeout(1));
});
