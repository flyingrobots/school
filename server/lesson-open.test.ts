// Opening a lesson writes the learner's encounter to the record, so it is a JSON POST, which the
// write guard covers on every origin; no GET writes to the record (flyingrobots/school#321). Any
// page in the learner's browser can make a GET with no script and no preflight, such as an
// untrusted course page's `<img src="/api/courses/c/lessons/l">`, and over plain HTTP on a name
// other than localhost (the phone on a tailnet name) the browser sends no fetch metadata a guard
// could check (flyingrobots/school#306).
// Oracles: the issue's acceptance items; the architecture doc's API table, which lists every GET
// route the server answers; and the record itself, read as its owner with the server stopped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./adapters/database.ts";
import { openPglite } from "./adapters/pglite.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import type { Block } from "./core/model.ts";
import { createSchool } from "./core/school.ts";
import { openLesson } from "./testing/lessons.ts";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const root = mkdtempSync(join(tmpdir(), "school-lesson-open-"));
const record = join(root, "record");
let server: Started | null = null;

const quiz = (id: string): Block => ({ type: "quiz", id, q: "Which?", why: "Because.", choices: [{ id: "a", text: "A", correct: true }, { id: "b", text: "B", correct: false }] });
const LESSONS: Block[] = [
  { type: "page", id: "l1", title: "One", subtitle: "", children: [quiz("q1"), { type: "explain", id: "e1", prompt: "Why?", model: "Because.", sources: [] }] },
  ...["l2", "resumed", "twice", "refused", "invalid"].map((id): Block => ({ type: "page", id, title: id, subtitle: "", children: [quiz(`${id}-q`)] })),
];

/** A bridge that answers every request with an empty JSON object, so the routes that ask it do. */
const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({}) });

async function start(): Promise<void> {
  server = await startSchool({
    ...process.env, SCHOOL_COURSES: `c=${join(root, "c")}`, SCHOOL_MOUNTS: `m=${join(root, "m")}`,
    SCHOOL_BRIDGE_URL: bridge.url.href.replace(/\/$/, ""), SCHOOL_BRIDGE_TOKEN: "lesson-open-test-token",
    SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${record}`, SCHOOL_WEB: join(root, "no-web"), HOST: "127.0.0.1",
  });
}
async function stop(): Promise<void> {
  server?.proc.kill();
  await server?.proc.exited;
  server = null;
}

/** The answer the seeded record holds, for `/api/aid/:submissionId`. */
const ANSWER = crypto.randomUUID();

/**
 * A record with something in it for every reader: an encounter of l1, tracked, with a wrong then a
 * right answer, a saved explanation, and a chosen time zone. Written in this process, through the
 * core, before the server starts, so no HTTP route is needed to seed it.
 */
async function seed(): Promise<void> {
  const db = await openDatabase({ driver: "pglite", dir: record });
  try {
    const school = createSchool({
      record: postgresRecord(db.sql),
      grader: { adapter: "none", model: "", rubricVersion: "", promptVersion: "", grade: () => Promise.reject(new Error("no grading here")) },
      clock: { now: () => new Date().toISOString() },
    });
    const { encounter } = await school.openLesson("c", LESSONS[0]!, 1, LESSONS, "UTC");
    expect((await school.submitAnswer({ submissionId: crypto.randomUUID(), encounterId: encounter.id, blockId: "q1", choiceId: "b", ms: 5 })).status).toBe("stored");
    expect((await school.submitAnswer({ submissionId: ANSWER, encounterId: encounter.id, blockId: "q1", choiceId: "a", ms: 5 })).status).toBe("stored");
    expect((await school.saveExplanation({ submissionId: crypto.randomUUID(), encounterId: encounter.id, blockId: "e1", text: "Because it is.", ms: 5 })).result.status).toBe("stored");
    await school.chooseTimeZone("Pacific/Auckland");
  } finally {
    await db.close();
  }
}

/**
 * Every row of every table in the record, and every sequence's value, read as the owner with the
 * server stopped (PGlite is one process's), then the server again. Tables are found, not listed,
 * so a table added later is compared too.
 */
async function snapshot(): Promise<{ tables: number; rows: Record<string, string[]> }> {
  await stop();
  const db = await openPglite(record);
  try {
    const tables = (await db.query<{ s: string; t: string }>(
      "SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2",
    )).rows;
    const rows: Record<string, string[]> = {};
    for (const { s, t } of tables) {
      rows[`${s}.${t}`] = (await db.query<{ row: string }>(`SELECT to_jsonb(x)::text AS row FROM "${s}"."${t}" x`)).rows.map((r) => r.row).sort();
    }
    rows["sequences"] = (await db.query<{ row: string }>("SELECT schemaname || '.' || sequencename || '=' || coalesce(last_value::text, 'null') AS row FROM pg_sequences")).rows.map((r) => r.row).sort();
    return { tables: tables.length, rows };
  } finally {
    await db.close();
    await start();
  }
}

/** How many encounters the record holds for `lesson`. */
async function encounters(lesson: string): Promise<number> {
  const { rows } = await snapshot();
  return rows["school.encounters"]!.filter((r) => (JSON.parse(r) as { lesson: string }).lesson === lesson).length;
}

/** The record as the seed left it, and as the latest GET test found it: each compares with the one before. */
let before: Awaited<ReturnType<typeof snapshot>>;
let last: Awaited<ReturnType<typeof snapshot>>["rows"];

beforeAll(async () => {
  mkdirSync(join(root, "c", "lessons"), { recursive: true });
  LESSONS.forEach((page, i) => writeFileSync(join(root, "c", "lessons", `000${i + 1}.json`), JSON.stringify(page)));
  mkdirSync(join(root, "c", "reference"), { recursive: true });
  writeFileSync(join(root, "c", "reference", "notes.html"), "<!doctype html><title>Notes</title><p>Notes.</p>");
  mkdirSync(join(root, "m"), { recursive: true });
  writeFileSync(join(root, "m", "source.txt"), "A source.");
  await seed();
  await start();
  before = await snapshot();
  last = before.rows;
}, timeout(3) + 20_000);
afterAll(async () => {
  await stop();
  bridge.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const TZ = "tz=Pacific%2FAuckland";
const UTT = `utt_${"0".repeat(32)}`;
/** The metadata Chrome sends with an untrusted course page's `<img>` over localhost or HTTPS. */
const IMAGE = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" };

/**
 * Each GET route of the architecture doc's API table, as its Path column writes it, with the
 * requests that exercise it here. The lesson is asked for in every way the web view used to be
 * opened, of the lesson the record holds and of one it has never opened.
 */
const GET_ROUTES: Record<string, string[]> = {
  "/api/courses": ["/api/courses"],
  "/api/resume": ["/api/resume"],
  "/api/feedback": ["/api/feedback"],
  "/api/review?tz=": [`/api/review?${TZ}`],
  "/api/activity?days=14&tz=": [`/api/activity?days=14&${TZ}`],
  "/api/showcase": ["/api/showcase"],
  "/api/courses/:c": ["/api/courses/c"],
  "/api/courses/:c/lessons/:id": [
    "/api/courses/c/lessons/l1", `/api/courses/c/lessons/l1?view=web&aid=1&${TZ}`, "/api/courses/c/lessons/l1?aid=1",
    "/api/courses/c/lessons/l2", `/api/courses/c/lessons/l2?view=web&aid=1&${TZ}`, "/api/courses/c/lessons/l2?view=slides",
  ],
  "/api/aid/:submissionId": [`/api/aid/${ANSWER}`],
  "/api/settings/status": ["/api/settings/status"],
  "/api/settings/authoring": ["/api/settings/authoring"],
  "/api/settings/bridge": ["/api/settings/bridge"],
  "/api/settings/agents": ["/api/settings/agents"],
  "/api/speak/:id": [`/api/speak/${UTT}`],
  "/api/speak/:id/segments/:n": [`/api/speak/${UTT}/segments/0`],
  "/api/settings/time-zone": ["/api/settings/time-zone"],
  "/courses/:c/reference/*": ["/courses/c/reference/notes.html"],
  "/<mount>/*": ["/m/source.txt"],
};
/** The web app's own pages, which the API table does not list: index.html for any page path (503 here, unbuilt). */
const APP_PAGES = ["/", "/courses/c/lessons/l2"];

/** The paths of the API table's rows whose Method column names GET. */
function documentedGets(): string[] {
  const doc = readFileSync(join(import.meta.dir, "..", "docs", "topics", "architecture", "README.md"), "utf8");
  return [...doc.matchAll(/^\| ([A-Z, ]+) \| `([^`]+)` \|/gm)].filter((m) => m[1]!.split(",").map((s) => s.trim()).includes("GET")).map((m) => m[2]!);
}

const REQUESTS: [string, Record<string, string>][] = [
  ...Object.values(GET_ROUTES).flat().map((path): [string, Record<string, string>] => [path, {}]),
  ...APP_PAGES.map((path): [string, Record<string, string>] => [path, {}]),
  // An image's metadata, as #306 checked for, is no different now: the GET reads.
  [`/api/courses/c/lessons/l2?view=web&aid=1&${TZ}`, IMAGE],
];

describe("no GET writes to the record", () => {
  test("the routes below are every GET route of the architecture doc's API table", () => {
    const documented = documentedGets();
    expect(documented.length).toBeGreaterThan(10); // the harvest found the table
    expect(new Set(Object.keys(GET_ROUTES))).toEqual(new Set(documented));
  });

  test("the record compared holds the seeded encounter, answers and explanation", () => {
    // Witnesses that the comparison below compares something.
    expect(before.tables).toBeGreaterThan(5);
    const count = (t: string) => before.rows[`school.${t}`]?.length;
    expect([count("encounters"), count("answers"), count("explanations"), count("time_zone_choices")]).toEqual([1, 2, 1, 1]);
  });

  test.each(REQUESTS)("GET %s %j leaves the record as it was", async (path, headers) => {
    const res = await fetch(server!.url + path, { headers });
    await res.arrayBuffer();
    expect(res.status).toBeLessThan(600); // answered at all
    const was = last;
    last = (await snapshot()).rows;
    expect(last).toEqual(was);
  }, timeout(1) + 10_000);
});

describe("reading a lesson with a GET", () => {
  test("in the web view gives the lesson and its neighbours, with no encounter", async () => {
    const res = await fetch(`${server!.url}/api/courses/c/lessons/l2?view=web&aid=1&${TZ}`);
    const body = await res.json();
    expect([res.status, body.view, body.lesson.id, body.prev?.id, body.next?.id, "encounterId" in body]).toEqual([200, "web", "l2", "l1", "resumed", false]);
  });

  test("in the slides view is as before, with no encounter", async () => {
    const res = await fetch(`${server!.url}/api/courses/c/lessons/l2?view=slides`);
    const body = await res.json();
    expect([res.status, body.view, body.lesson.id, "encounterId" in body]).toEqual([200, "slides", "l2", false]);
  });
});

describe("opening a lesson with a POST", () => {
  test("opens a tracked encounter, with the lesson, its neighbours and nothing answered yet", async () => {
    const res = await openLesson(server!.url, "c", "l2", `?aid=1&${TZ}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect([res.status, body.view, body.lesson.id, body.prev?.id, typeof body.encounterId, body.answers, body.explanations, body.review])
      .toEqual([200, "web", "l2", "l1", "string", [], [], []]);
  });

  test("resumes the open encounter, with what the learner already answered in it", async () => {
    const opened = await openLesson(server!.url, "c", "resumed", "?aid=1");
    expect(opened.status).toBe(200);
    const first = await opened.json();
    const answered = await fetch(server!.url + "/api/answer", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ submissionId: crypto.randomUUID(), encounterId: first.encounterId, blockId: "resumed-q", choiceId: "a", ms: 5 }),
    });
    expect(answered.status).toBe(200);
    const again = await (await openLesson(server!.url, "c", "resumed", "?aid=1")).json();
    expect([again.encounterId, again.answers.map((a: { choiceId: string }) => a.choiceId)]).toEqual([first.encounterId, ["a"]]);
  });

  // The known failure mode: the page opening twice (React's development double effect, a retry).
  test("twice at once resumes one encounter, and the record holds one", async () => {
    const [a, b] = await Promise.all([openLesson(server!.url, "c", "twice", "?aid=1"), openLesson(server!.url, "c", "twice", "?aid=1")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const ids = [(await a.json()).encounterId, (await b.json()).encounterId];
    expect(ids[0]).toBeString();
    expect(ids[1]).toBe(ids[0]);
    expect(await encounters("twice")).toBe(1);
  }, timeout(1) + 10_000);

  // Oracle: the write guard every POST under /api/ has (architecture doc, "The server"): a declared
  // JSON body, which a page cannot send another origin without a preflight School never answers,
  // and no request the browser says is cross-site, as a sandboxed page's always is.
  test.each([
    ["a form's urlencoded body", { "content-type": "application/x-www-form-urlencoded" }, 415],
    ["a beacon's plain text", { "content-type": "text/plain" }, 415],
    ["no content type", { "content-type": "" }, 415],
    ["a cross-site JSON request", { "sec-fetch-site": "cross-site" }, 403],
  ] as const)("is refused for %s", async (_, headers, status) => {
    const res = await openLesson(server!.url, "c", "refused", "?aid=1", headers);
    await res.arrayBuffer();
    expect(res.status).toBe(status);
  });

  test("a refused POST leaves no encounter in the record", async () => {
    const refusals: Record<string, string>[] = [{ "content-type": "text/plain" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of refusals) {
      expect((await openLesson(server!.url, "c", "refused", "?aid=1", headers)).status).toBeGreaterThanOrEqual(400);
    }
    expect(await encounters("refused")).toBe(0);
  }, timeout(1) + 10_000);

  const INVALID = [
    ["an unknown aid capture version", "c", "invalid", "?aid=2", 400],
    ["a tz that is not a zone", "c", "invalid", "?aid=1&tz=Not%2FAZone", 400],
    ["the slides view, which records nothing", "c", "invalid", "?view=slides", 400],
    ["a lesson the course does not have", "c", "no-such-lesson", "?aid=1", 404],
    ["a course School does not serve", "no-such-course", "invalid", "?aid=1", 404],
  ] as const;

  test.each(INVALID)("is refused for %s, with no encounter in the reply", async (_, course, lesson, query, status) => {
    const res = await openLesson(server!.url, course, lesson, query);
    expect(res.status).toBe(status);
    expect("encounterId" in (await res.json())).toBe(false);
  });

  test("an invalid POST leaves no encounter in the record", async () => {
    for (const [, course, lesson, query] of INVALID) expect((await openLesson(server!.url, course, lesson, query)).status).toBeGreaterThanOrEqual(400);
    expect(await encounters("invalid")).toBe(0);
  }, timeout(1) + 10_000);
});
