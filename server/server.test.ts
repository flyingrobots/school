// The record contract over HTTP, against the real server process (flyingrobots/school#2).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "school-http-"));
const courseDir = join(root, "demo");
const state = join(root, "state");
const PORT = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof Bun.spawn> | null = null;

const quiz = (id: string) => ({
  type: "quiz", id, q: `Question ${id}?`, why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});

async function start(): Promise<void> {
  server = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], {
    env: { ...process.env, SCHOOL_COURSE: courseDir, SCHOOL_STATE: state, PORT: String(PORT), HOST: "127.0.0.1" },
    stdout: "ignore", stderr: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + "/")).ok) return;
    } catch {}
    await Bun.sleep(50);
  }
  throw new Error("server did not start");
}
async function stop(): Promise<void> {
  server?.kill("SIGKILL"); // no graceful shutdown: a committed answer must survive a hard kill
  await server?.exited;
  server = null;
}

beforeAll(async () => {
  mkdirSync(join(courseDir, "lessons"), { recursive: true });
  writeFileSync(join(courseDir, "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "l1", title: "One", subtitle: "", children: [quiz("q1"), quiz("q2")] }));
  await start();
});
afterAll(async () => {
  await stop();
  rmSync(root, { recursive: true, force: true });
});

type Lesson = { encounterId?: string; answers?: { blockId: string; choiceId: string; correct: boolean }[] };
const page = async (view = "web"): Promise<Lesson> => (await fetch(`${base}/api/courses/demo/lessons/l1?view=${view}`)).json();
const encounterOf = (lesson: Lesson) => lesson.encounterId ?? null;
const answer = (body: Record<string, unknown>) =>
  fetch(base + "/api/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const rows = () => {
  const db = new Database(join(state, "progress.db"), { readonly: true });
  try {
    return db.query<Record<string, unknown>, []>(
      "SELECT a.*, e.snapshot_hash FROM answers a LEFT JOIN encounters e ON e.id = a.encounter_id ORDER BY a.id").all();
  } finally {
    db.close();
  }
};

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

  const stored = rows();
  expect(stored).toHaveLength(2);
  expect(stored.map((r) => r.first_try)).toEqual([1, 0]);
  for (const r of stored) for (const k of ["encounter_id", "snapshot_hash", "block_id", "choice_id", "submission_id"]) expect(r[k]).toBeTruthy();
});

test("a reload resumes the encounter and shows what was already answered", async () => {
  const lesson = await page();
  const e = encounterOf(lesson)!;
  expect(new Set(rows().map((r) => r.encounter_id))).toEqual(new Set([e]));
  // What is already answered in this encounter comes back with the lesson, so the app can show it.
  expect(lesson.answers?.map((a) => [a.blockId, a.choiceId, a.correct])).toEqual([["q1", "wrong", false], ["q1", "right", true]]);
});

test("the server's restart, even a hard kill, loses no progress", async () => {
  const before = rows();
  await stop();
  await start();
  expect(rows()).toEqual(before);
  // And the learner lands back in the same encounter, with q1 still shown as answered.
  const lesson = await page();
  expect(encounterOf(lesson)).toBe(before[0]!.encounter_id as string);
  expect(lesson.answers?.some((a) => a.blockId === "q1" && a.correct)).toBe(true);
});

test("the course shows progress from the database", async () => {
  const course = await (await fetch(`${base}/api/courses/demo`)).json();
  expect(course.lessons[0]).toMatchObject({ id: "l1", quizzes: 2, answeredCorrectly: 1 });
});

test("a client cannot claim correctness, and bad submissions store nothing", async () => {
  const e = encounterOf(await page())!;
  const n = rows().length;
  const forged = await answer({ submissionId: crypto.randomUUID(), encounterId: e, blockId: "q2", choiceId: "wrong", ms: 1, correct: true, firstTry: true });
  expect(await forged.json()).toMatchObject({ correct: false });

  expect((await answer({ submissionId: "not-a-uuid", encounterId: e, blockId: "q2", choiceId: "right", ms: 1 })).status).toBe(400);
  expect((await answer({ submissionId: crypto.randomUUID(), encounterId: crypto.randomUUID(), blockId: "q2", choiceId: "right", ms: 1 })).status).toBe(400);
  expect((await answer({ submissionId: crypto.randomUUID(), encounterId: e, blockId: "q2", choiceId: "nope", ms: 1 })).status).toBe(400);
  expect(rows().length).toBe(n + 1);
});

test("the slides view opens no encounter and records nothing", async () => {
  const db = () => new Database(join(state, "progress.db"), { readonly: true });
  const count = () => { const d = db(); try { return d.query<{ n: number }, []>("SELECT count(*) AS n FROM encounters").get()!.n; } finally { d.close(); } };
  const before = count();
  const lesson = await page("slides");
  expect(encounterOf(lesson)).toBeNull();
  expect(count()).toBe(before);
});
