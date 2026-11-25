// Delayed review over HTTP (RFC 2 §5; flyingrobots/school#32), against the real server process: a
// record holding yesterday's wrong answer, then GET of another lesson, which carries the item in a
// Review section at its top with the reason in words, and a reload that shows the same.
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
const page = (id: string, title: string, quizzes: string[]): Block =>
  ({ type: "page", id, title, subtitle: "", children: quizzes.map(quiz) });
const l1 = page("l1", "Orbits", ["q1", "q2"]);
const l2 = page("l2", "Tides", ["q3"]);
const YESTERDAY = new Date(Date.now() - 2 * 24 * 3600 * 1000);
const yesterday = (ms: number) => new Date(YESTERDAY.getTime() + ms).toISOString();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-review-"));
  mkdirSync(join(root, "c", "lessons"), { recursive: true });
  writeFileSync(join(root, "c", "lessons", "0001.json"), JSON.stringify(l1));
  writeFileSync(join(root, "c", "lessons", "0002.json"), JSON.stringify(l2));
  // A second course, opened with the learner's zone (flyingrobots/school#178).
  mkdirSync(join(root, "d", "lessons"), { recursive: true });
  writeFileSync(join(root, "d", "lessons", "0001.json"), JSON.stringify(page("m1", "Bells", ["b1"])));
  writeFileSync(join(root, "d", "lessons", "0002.json"), JSON.stringify(page("m2", "Changes", ["b2"])));
  // Two days ago, as the server's own record would hold it: q1 wrong then right, q2 right first try.
  const dir = join(root, "record");
  const db = await openDatabase({ driver: "pglite", dir });
  const r = postgresRecord(db.sql);
  const e = await r.openEncounter({ course: "c", lesson: "l1", page: l1, now: yesterday(0), aidTracking: 1 });
  for (const [blockId, choiceId, ms] of [["q1", "wrong", 1000], ["q1", "right", 2000], ["q2", "right", 3000]] as const) {
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId, choiceId, ms: 10 }, yesterday(ms));
  }
  const d = await r.openEncounter({ course: "d", lesson: "m1", page: page("m1", "Bells", ["b1"]), now: yesterday(0), aidTracking: 1 });
  for (const [choiceId, ms] of [["wrong", 1000], ["right", 2000]] as const) {
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: d.id, blockId: "b1", choiceId, ms: 10 }, yesterday(ms));
  }
  await db.close();
  server = await startSchool({
    ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${dir}`, SCHOOL_COURSES: `c=${join(root, "c")},d=${join(root, "d")}`,
    TZ: "Pacific/Auckland", // a reason names the day in the server's time zone
  });
}, timeout(1));
afterAll(async () => {
  server?.proc.kill();
  await server?.proc.exited;
  if (root) rmSync(root, { recursive: true, force: true });
});

const get = async (path: string) => {
  const r = await fetch(server!.url + path);
  expect(r.status).toBe(200);
  return r.json();
};

test("the next lesson opens with the item due in a Review section at its top, its reason in words, and a reload shows the same", async () => {
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "Pacific/Auckland" }).format(YESTERDAY);
  const opened = await get("/api/courses/c/lessons/l2?aid=1");
  expect(opened.lesson).toEqual({ ...l2, children: [{ type: "section", id: "school:review", title: "Review", children: [quiz("q1")] }, quiz("q3")] });
  expect(opened.review).toEqual([{
    blockId: "q1", rule: "due-review/wrong-first-try",
    reason: `On ${day}, you found this one on a second go. It's back so you can answer it from memory.`,
    // The lesson that holds the quiz (flyingrobots/school#159).
    from: { id: "l1", title: "Orbits" },
  }]);
  // The review block is answered in this lesson's encounter like any of its own.
  const answered = await fetch(server!.url + "/api/answer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ submissionId: crypto.randomUUID(), encounterId: opened.encounterId, blockId: "q1", choiceId: "right", ms: 10 }),
  });
  expect(await answered.json()).toMatchObject({ status: "stored", correct: true, firstTry: true });
  const again = await get("/api/courses/c/lessons/l2?aid=1");
  expect(again.encounterId).toBe(opened.encounterId);
  expect(again.lesson).toEqual(opened.lesson);
  expect(again.review).toEqual(opened.review);
  expect(again.answers).toEqual([{ blockId: "q1", choiceId: "right", correct: true }]);
  // A review answer in Tides is not progress in Tides: its own quiz is still to answer.
  expect((await get("/api/courses"))[0]).toEqual({ name: "c", title: "c", lessons: 2, reference: 0, quizzes: 3, answeredCorrectly: 2 });
});

test("the slides view records nothing, so it carries no review", async () => {
  const slides = await get("/api/courses/c/lessons/l2?view=slides");
  expect(slides.lesson).toEqual(l2);
  expect(slides.review).toBeUndefined();
});

test("a lesson opened with the learner's zone names the day in it, and refuses a zone that is not one", async () => {
  const tz = "Pacific/Pago_Pago"; // UTC-11, a day behind Auckland at most hours
  const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: tz }).format(new Date(YESTERDAY.getTime() + 1000));
  const opened = await get(`/api/courses/d/lessons/m2?aid=1&tz=${encodeURIComponent(tz)}`);
  expect(opened.review[0].reason).toStartWith(`On ${day}, `);
  expect((await fetch(server!.url + "/api/courses/d/lessons/m2?aid=1&tz=Not%2FAZone")).status).toBe(400);
});
