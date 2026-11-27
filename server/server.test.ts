// The record contract over HTTP, against the real server process (flyingrobots/school#2).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchool, timeout, type Started } from "./testing/processes.ts";
import { ownerQuery } from "./testing/record.ts";

// Every test gets its own server, state and port, and sets up what it needs: none depends on
// another having run first.
let root = "";
let courseDir = "";
let state = "";
let record = "";
let base = "";
let server: Started | null = null;

const quiz = (id: string) => ({
  type: "quiz", id, q: `Question ${id}?`, why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});

async function start(): Promise<void> {
  server = await startSchool({ ...process.env, SCHOOL_COURSE: courseDir, SCHOOL_STATE: state, SCHOOL_DATABASE_URL: `pglite:${record}`, HOST: "127.0.0.1" });
  base = server.url;
}
async function stop(): Promise<void> {
  server?.proc.kill("SIGKILL"); // no graceful shutdown: a committed answer must survive a hard kill
  await server?.proc.exited;
  server = null;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "school-http-"));
  courseDir = join(root, "demo");
  state = join(root, "state");
  record = join(root, "record"); // this test's own PGlite record
  mkdirSync(join(courseDir, "lessons"), { recursive: true });
  writeFileSync(join(courseDir, "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "l1", title: "One", subtitle: "", children: [quiz("q1"), quiz("q2")] }));
  await start();
}, timeout(1));
afterEach(async () => {
  await stop();
  rmSync(root, { recursive: true, force: true });
});

type Lesson = { encounterId?: string; answers?: { blockId: string; choiceId: string; correct: boolean }[] };
const page = async (view = "web"): Promise<Lesson> => (await fetch(`${base}/api/courses/demo/lessons/l1?view=${view}`)).json();
const encounterOf = (lesson: Lesson) => lesson.encounterId ?? null;
const answer = (body: Record<string, unknown>) =>
  fetch(base + "/api/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/**
 * What the record holds, read as its owner: PGlite is one process's database, so the server is
 * stopped (hard, as stop() always is) for the read and started again after it.
 */
async function owner<T = Record<string, unknown>>(text: string): Promise<T[]> {
  await stop();
  try {
    return await ownerQuery<T>(record, text);
  } finally {
    await start();
  }
}
const rows = () => owner("SELECT a.*, e.snapshot_hash FROM school.answers a LEFT JOIN school.encounters e ON e.id = a.encounter_id ORDER BY a.seq");

/** The learner answers q1 wrong, then right; returns the encounter. */
async function wrongThenRight(): Promise<string> {
  const e = encounterOf(await page())!;
  for (const choiceId of ["wrong", "right"]) {
    expect((await answer({ submissionId: crypto.randomUUID(), encounterId: e, blockId: "q1", choiceId, ms: 10 })).status).toBe(200);
  }
  return e;
}

test("acceptance over HTTP: wrong, right, then the right answer resent five times at once", async () => {
  const e = encounterOf(await page())!;
  expect(e).toBeTruthy();
  const wrong = await answer({ submissionId: crypto.randomUUID(), encounterId: e, blockId: "q1", choiceId: "wrong", ms: 10 });
  expect(await wrong.json()).toMatchObject({ status: "stored", correct: false, firstTry: true });

  const right = { submissionId: crypto.randomUUID(), encounterId: e, blockId: "q1", choiceId: "right", ms: 20 };
  const all = await Promise.all(Array.from({ length: 5 }, () => answer(right)));
  expect(all.every((r) => r.status === 200)).toBe(true);
  const statuses = (await Promise.all(all.map((r) => r.json()))).map((b) => b.status).sort();
  expect(statuses).toEqual(["duplicate", "duplicate", "duplicate", "duplicate", "stored"]);

  const stored = await rows();
  expect(stored).toHaveLength(2);
  expect(stored.map((r) => r.first_try)).toEqual([true, false]);
  for (const r of stored) for (const k of ["encounter_id", "snapshot_hash", "block_id", "choice_id", "submission_id"]) expect(r[k]).toBeTruthy();
}, timeout(1));

test("a reload resumes the encounter and shows what was already answered", async () => {
  await wrongThenRight();
  const lesson = await page();
  const e = encounterOf(lesson)!;
  expect(new Set((await rows()).map((r) => r.encounter_id))).toEqual(new Set([e]));
  // What is already answered in this encounter comes back with the lesson, so the app can show it.
  expect(lesson.answers?.map((a) => [a.blockId, a.choiceId, a.correct])).toEqual([["q1", "wrong", false], ["q1", "right", true]]);
}, timeout(1));

test("the server's restart, even a hard kill, loses no progress", async () => {
  await wrongThenRight();
  const before = await rows();
  await stop();
  await start();
  expect(await rows()).toEqual(before);
  // And the learner lands back in the same encounter, with q1 still shown as answered.
  const lesson = await page();
  expect(encounterOf(lesson)).toBe(before[0]!.encounter_id as string);
  expect(lesson.answers?.some((a) => a.blockId === "q1" && a.correct)).toBe(true);
}, timeout(3));

test("the course shows progress from the database", async () => {
  await wrongThenRight();
  const course = await (await fetch(`${base}/api/courses/demo`)).json();
  expect(course.lessons[0]).toMatchObject({ id: "l1", quizzes: 2, answeredCorrectly: 1 });
});

test("a client cannot claim correctness, and bad submissions store nothing", async () => {
  const e = encounterOf(await page())!;
  const n = (await rows()).length;
  const forged = await answer({ submissionId: crypto.randomUUID(), encounterId: e, blockId: "q2", choiceId: "wrong", ms: 1, correct: true, firstTry: true });
  expect(await forged.json()).toMatchObject({ correct: false });

  expect((await answer({ submissionId: "not-a-uuid", encounterId: e, blockId: "q2", choiceId: "right", ms: 1 })).status).toBe(400);
  expect((await answer({ submissionId: crypto.randomUUID(), encounterId: crypto.randomUUID(), blockId: "q2", choiceId: "right", ms: 1 })).status).toBe(400);
  expect((await answer({ submissionId: crypto.randomUUID(), encounterId: e, blockId: "q2", choiceId: "nope", ms: 1 })).status).toBe(400);
  expect((await rows()).length).toBe(n + 1);
}, timeout(2));

test("the slides view opens no encounter and records nothing", async () => {
  const count = async () => (await owner<{ n: number }>("SELECT count(*)::int AS n FROM school.encounters"))[0]!.n;
  const before = await count();
  const lesson = await page("slides");
  expect(encounterOf(lesson)).toBeNull();
  expect(await count()).toBe(before);
}, timeout(2));

// A route that throws with no error handler would show Bun's development error page, with source and
// paths, and production never sets NODE_ENV. A handler-less server cannot be built from outside, so
// the option itself is asserted: removing the handler later cannot bring the page back (flyingrobots/school#346).
test("the server turns Bun's development error page off explicitly", () => {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  expect(source).toMatch(/Bun\.serve\(\{[^}]*?development:\s*false/s);
});
