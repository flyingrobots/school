// Each item of a cross-course reply says whether its course is trusted (flyingrobots/school#272),
// over HTTP against the real server process. `/api/review`, `/api/feedback`, `/api/resume` and
// `/api/activity` carry course-written text (titles, questions, prompts) from every served course
// in one reply, so a client can only treat an untrusted course's text more strictly if each item
// says which it is. `trusted` is an added field: every other field is as it was.
// Oracle: the issue's section 2d. An item's `trusted` is its course's, as `GET /api/courses` gives
// it; an item whose course is no longer served is not trusted, since nothing vouches for it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./adapters/database.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import type { Block, GradingRecord } from "./core/model.ts";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const HOUR = 3600 * 1000;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const quiz = (id: string): Block => ({
  type: "quiz", id, q: `Question ${id}?`, why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});
const explain: Block = { type: "explain", id: "e1", prompt: "How would you say why?", model: "Because.", sources: [] };
const lessonOf = (course: string): Block => ({ type: "page", id: `${course}-1`, title: `${course} lesson`, subtitle: "", children: [quiz("q1"), quiz("q2"), quiz("q3"), explain] });
const findings: NonNullable<GradingRecord["findings"]> = {
  insufficient_evidence: false, summary: "Good start.", contradictions: [],
  fidelity: { verdict: "meets", note: "Right idea." }, completeness: { verdict: "partly", note: "One more step." },
  accessibility: { verdict: "meets", note: "Plain words." },
};

let root = "";
/** Both courses served; `guest` studied last, so its explanation holds the newest feedback. */
let guestLast: Started | null = null;
/** Both courses served; `own` studied last. */
let ownLast: Started | null = null;
/** Only `guest` served, over the record where `own` was studied last: every item is untrusted. */
let guestOnly: Started | null = null;

/**
 * A record where each course's q1 was answered wrong then right two days ago (so it is due now),
 * q2 wrong then right ten hours ago (so it comes back tomorrow), and an explanation was graded.
 * q3 is never answered, so the lesson is still to continue. The course named last was studied, and
 * graded, most recently.
 */
async function seed(dir: string, order: readonly [string, string]): Promise<void> {
  const db = await openDatabase({ driver: "pglite", dir });
  const r = postgresRecord(db.sql);
  for (const [k, course] of order.entries()) {
    const page = lessonOf(course);
    const shift = k * 60_000; // the second course a minute later in every step
    const e = await r.openEncounter({ course, lesson: page.id, page, now: ago(48 * HOUR - shift), aidTracking: 1 });
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 10 }, ago(48 * HOUR - shift - 1000));
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "q1", choiceId: "right", ms: 10 }, ago(48 * HOUR - shift - 2000));
    const e2 = await r.openEncounter({ course, lesson: page.id, page, now: ago(10 * HOUR - shift), aidTracking: 1 });
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: e2.id, blockId: "q2", choiceId: "wrong", ms: 10 }, ago(10 * HOUR - shift - 1000));
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: e2.id, blockId: "q2", choiceId: "right", ms: 10 }, ago(10 * HOUR - shift - 2000));
    const sub = crypto.randomUUID();
    await r.saveExplanation({ submissionId: sub, encounterId: e2.id, blockId: "e1", text: "Because it is.", ms: 10 }, ago(10 * HOUR - shift - 3000));
    await r.recordGrading({ status: "succeeded", error: null, submissionId: sub, rubricVersion: "r", promptVersion: "p", adapter: "test",
      model: "claude", sources: [], raw: "{}", findings }, ago(10 * HOUR - shift - 4000));
  }
  await db.close();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-item-trust-"));
  for (const course of ["own", "guest"]) {
    mkdirSync(join(root, course, "lessons"), { recursive: true });
    writeFileSync(join(root, course, "course.json"), JSON.stringify({ title: `${course} title` }));
    writeFileSync(join(root, course, "lessons", "0001.json"), JSON.stringify(lessonOf(course)));
  }
  await seed(join(root, "guest-last"), ["own", "guest"]);
  await seed(join(root, "own-last"), ["guest", "own"]);
  await seed(join(root, "guest-only"), ["guest", "own"]);
  const serve = (record: string, trusted: boolean) => startSchool({
    ...process.env, HOST: "127.0.0.1", SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_STATE: join(root, `state-${record}`), SCHOOL_DATABASE_URL: `pglite:${join(root, record)}`,
    SCHOOL_UNTRUSTED_COURSES: `guest=${join(root, "guest")}`,
    ...(trusted ? { SCHOOL_COURSES: `own=${join(root, "own")}` } : {}),
  });
  [guestLast, ownLast, guestOnly] = await Promise.all([serve("guest-last", true), serve("own-last", true), serve("guest-only", false)]);
}, timeout(3));
afterAll(async () => {
  for (const s of [guestLast, ownLast, guestOnly]) {
    s?.proc.kill();
    await s?.proc.exited;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

async function get(s: Started | null, path: string): Promise<unknown> {
  const r = await fetch(s!.url + path);
  expect(r.status).toBe(200);
  return r.json();
}
type Item = { course: string; trusted?: unknown };
const trustOf = (items: Item[]) => items.map((i) => [i.course, i.trusted]);

describe("one trusted and one untrusted course", () => {
  test("GET /api/review gives each question its course's trusted", async () => {
    expect(trustOf((await get(guestLast, "/api/review")) as Item[])).toEqual([["guest", false], ["own", true]]);
  });

  test("GET /api/activity gives each course's lane its trusted", async () => {
    expect(trustOf(((await get(guestLast, "/api/activity")) as { courses: Item[] }).courses)).toEqual([["guest", false], ["own", true]]);
  });

  test.each([["guest", false, () => guestLast], ["own", true, () => ownLast]] as const)(
    "GET /api/feedback from %s, graded last, gives trusted: %p", async (course, trusted, server) => {
      expect(trustOf([(await get(server(), "/api/feedback")) as Item])).toEqual([[course, trusted]]);
    });

  test.each([["guest", false, () => guestLast], ["own", true, () => ownLast]] as const)(
    "GET /api/resume in %s, studied last, gives trusted: %p", async (course, trusted, server) => {
      expect(trustOf([(await get(server(), "/api/resume")) as Item])).toEqual([[course, trusted]]);
    });

  test("trusted is added beside every field the replies had, which are unchanged", async () => {
    const review = (await get(guestLast, "/api/review")) as Record<string, unknown>[];
    expect(review.map((i) => Object.keys(i).sort())).toEqual(Array(2).fill(
      ["answeredAt", "blockId", "course", "courseTitle", "lesson", "question", "reason", "rule", "trusted"]));
    const feedback = (await get(guestLast, "/api/feedback")) as Record<string, unknown>;
    expect(feedback).toEqual({
      course: "guest", courseTitle: "guest title", trusted: false, lesson: { id: "guest-1", title: "guest lesson" }, blockId: "e1",
      prompt: "How would you say why?", model: "claude", findings, at: expect.any(String),
    });
    const resume = (await get(guestLast, "/api/resume")) as Record<string, unknown>;
    expect(Object.keys(resume).sort()).toEqual(["course", "kind", "lastStudied", "lesson", "question", "trusted"]);
    // flyingrobots/school#222 added quizzes and mastery, how the course is holding today.
    const lane = ((await get(guestLast, "/api/activity")) as { courses: Record<string, unknown>[] }).courses[0]!;
    expect(Object.keys(lane).sort()).toEqual(["course", "courseTitle", "due", "mastery", "quizzes", "studied", "trusted"]);
  });
});

describe("only an untrusted course", () => {
  test("every item in every reply is untrusted", async () => {
    const review = (await get(guestOnly, "/api/review")) as Item[];
    const activity = ((await get(guestOnly, "/api/activity")) as { courses: Item[] }).courses;
    const resume = (await get(guestOnly, "/api/resume")) as Item;
    expect({ review: trustOf(review), activity: trustOf(activity), resume: trustOf([resume]) })
      .toEqual({ review: [["guest", false]], activity: [["guest", false]], resume: [["guest", false]] });
  });

  test("feedback from a course no longer served is not trusted", async () => {
    // `own` was graded last in this record, but this server does not serve it.
    expect(trustOf([(await get(guestOnly, "/api/feedback")) as Item])).toEqual([["own", false]]);
  });
});
