// What the home page reads (flyingrobots/school#39), over HTTP against the real server process:
// each course's progress on GET /api/courses, and where the learner left off on GET /api/resume.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

let root = "";
let server: Started | null = null;

const quiz = (id: string) => ({
  type: "quiz", id, q: `Question ${id}?`, why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});
const page = (id: string, title: string, quizzes: string[]) =>
  JSON.stringify({ type: "page", id, title, subtitle: `About ${title}`, children: quizzes.map(quiz) });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-home-"));
  mkdirSync(join(root, "aion", "lessons"), { recursive: true });
  writeFileSync(join(root, "aion", "lessons", "0001.json"), page("l1", "Orbits", ["q1", "q2"]));
  writeFileSync(join(root, "aion", "lessons", "0002.json"), page("l2", "Tides", ["q3"]));
  mkdirSync(join(root, "empty"), { recursive: true });
  mkdirSync(join(root, "broken", "lessons"), { recursive: true });
  writeFileSync(join(root, "broken", "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "b1", title: "B", subtitle: "", children: [{ ref: "missing" }] }));
  server = await startSchool({
    ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
    SCHOOL_COURSES: ["aion", "empty", "broken"].map((c) => `${c}=${join(root, c)}`).join(","),
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
async function answer(lesson: string, blockId: string, choiceId: string) {
  const opened = await get(`/api/courses/aion/lessons/${lesson}`);
  const r = await fetch(server!.url + "/api/answer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ submissionId: crypto.randomUUID(), encounterId: opened.encounterId, blockId, choiceId, ms: 10 }),
  });
  expect(r.status).toBe(200);
}

// One server, one record: the cases run in order, from a fresh record to a finished lesson. Courses
// come in the order the server lists them, by name.
test("a fresh record starts the first lesson, and every course's progress is told in counts", async () => {
  expect(await get("/api/courses")).toEqual([
    { name: "aion", title: "aion", summary: null, author: null, license: null, format: null, lessons: 2, reference: 0, quizzes: 3, answeredCorrectly: 0 },
    { name: "broken", title: "broken", summary: null, author: null, license: null, format: null, lessons: null, reference: 0, quizzes: null, answeredCorrectly: null },
    { name: "empty", title: "empty", summary: null, author: null, license: null, format: null, lessons: 0, reference: 0, quizzes: 0, answeredCorrectly: 0 },
  ]);
  expect(await get("/api/resume")).toEqual({
    kind: "start", course: "aion", lastStudied: null, question: null,
    lesson: { id: "l1", title: "Orbits", subtitle: "About Orbits", position: 1, of: 2, quizzes: 2, answeredCorrectly: 0 },
  });
});

test("after an answer the lesson is continued, with the next question still to answer", async () => {
  await answer("l1", "q1", "right");
  expect((await get("/api/courses"))[0]).toMatchObject({ name: "aion", quizzes: 3, answeredCorrectly: 1 });
  const resume = await get("/api/resume");
  expect(resume).toMatchObject({ kind: "continue", course: "aion", question: "Question q2?", lesson: { id: "l1", answeredCorrectly: 1 } });
  expect(Number.isNaN(Date.parse(resume.lastStudied))).toBe(false);
});

test("once the lesson is finished, the next lesson is up", async () => {
  await answer("l1", "q2", "right");
  expect(await get("/api/resume")).toMatchObject({ kind: "next", course: "aion", question: null, lesson: { id: "l2", title: "Tides", position: 2 } });
});
