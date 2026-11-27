// Each lesson's mastery counts over HTTP (RFC 5 Table 5.1 step 4; flyingrobots/school#220), against the
// real server process at a fixed clock: a record holding one quiz in each state, then GET of the course.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./adapters/database.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import type { Block } from "./core/model.ts";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

let root = "";
let server: Started | null = null;

const quiz = (id: string): Block => ({
  type: "quiz", id, q: `Question ${id}?`, why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});
const l1 = { type: "page", id: "l1", title: "Orbits", subtitle: "Round and round", children: ["q1", "q2", "q3", "q4"].map(quiz) } satisfies Block;
const l2 = { type: "page", id: "l2", title: "Reading", subtitle: "", children: [{ type: "prose", id: "p1", html: "<p>Nothing to answer.</p>" }] } satisfies Block;

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-01-01T10:00:00.000Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString();
/** The server's now. Months before the day this runs, so a server reading the system clock sees every answered quiz faded. */
const NOW = at(2);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-course-mastery-"));
  mkdirSync(join(root, "c", "lessons"), { recursive: true });
  writeFileSync(join(root, "c", "lessons", "0001.json"), JSON.stringify(l1));
  writeFileSync(join(root, "c", "lessons", "0002.json"), JSON.stringify(l2));
  // As the server's own record would hold it, in one encounter with aid tracked. Each quiz's state
  // at day 2 is RFC 5 Table 4.5's (docs/topics/mastery/README.md, Table 4):
  // q1 never answered: not started. q2 wrong first try at day 0: settling.
  // q3 clean at day 1.5: strength 0.5^(0.5 / 1) = 0.71, holding. q4 clean at day 0: strength 0.5^2 = 0.25, faded.
  const dir = join(root, "record");
  const db = await openDatabase({ driver: "pglite", dir });
  const r = postgresRecord(db.sql);
  const e = await r.openEncounter({ course: "c", lesson: "l1", page: l1, now: at(0), aidTracking: 1 });
  for (const [blockId, choiceId, when] of [["q2", "wrong", at(0)], ["q4", "right", at(0)], ["q3", "right", at(1.5)]] as const) {
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId, choiceId, ms: 10 }, when);
  }
  await db.close();
  server = await startSchool({
    ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${dir}`, SCHOOL_COURSES: `c=${join(root, "c")}`, SCHOOL_TEST_CLOCK: NOW,
  });
}, timeout(1));
afterAll(async () => {
  server?.proc.kill();
  await server?.proc.exited;
  if (root) rmSync(root, { recursive: true, force: true });
});

const lessons = async (path = "/api/courses/c", headers: Record<string, string> = {}) => {
  const r = await fetch(server!.url + path, { headers });
  expect(r.status).toBe(200);
  return (await r.json()).lessons;
};

test("a lesson with one quiz in each state reports one of each, beside its fields as they were", async () => {
  // Oracle: the states above, worked from RFC 5 Table 4.5; the other fields are the API's before this change.
  expect((await lessons())[0]).toEqual({
    id: "l1", title: "Orbits", subtitle: "Round and round", quizzes: 4, answeredCorrectly: 2,
    mastery: { notStarted: 1, settling: 1, holding: 1, faded: 1 },
  });
});

test("a lesson with no quizzes reports zero in every state", async () => {
  expect((await lessons())[1]).toEqual({
    id: "l2", title: "Reading", subtitle: "", quizzes: 0, answeredCorrectly: 0,
    mastery: { notStarted: 0, settling: 0, holding: 0, faded: 0 },
  });
});

test("the counts are at the server's clock, whatever time the client says it is", async () => {
  // Read at the client's day 1, q4 would be at exactly half strength and so holding: holding 2,
  // faded 0. Read at the client's 2031, q3 would be faded too: holding 0, faded 2.
  for (const now of [at(1), "2031-06-01T00:00:00.000Z"]) {
    const q = encodeURIComponent(now);
    const got = await lessons(`/api/courses/c?now=${q}&at=${q}&clock=${q}`, { date: new Date(now).toUTCString() });
    expect(got[0].mastery).toEqual({ notStarted: 1, settling: 1, holding: 1, faded: 1 });
  }
});
