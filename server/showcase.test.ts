// What's ahead in the learner's courses, for the home page (flyingrobots/school#164), over HTTP
// against the real server process: GET /api/showcase.
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
const page = (id: string, title: string, quizzes: string[], hook?: object) =>
  JSON.stringify({ type: "page", id, title, subtitle: `About ${title}`, ...(hook ? { hook } : {}), children: quizzes.map(quiz) });

const ORBITS = { question: "Why do planets keep going?", teaser: "Nothing stops them.", figure: "<svg><circle r=\"1\"/></svg>" };

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-showcase-"));
  mkdirSync(join(root, "astro", "lessons"), { recursive: true });
  writeFileSync(join(root, "astro", "course.json"), JSON.stringify({ title: "Astronomy" }));
  writeFileSync(join(root, "astro", "lessons", "0001.json"), page("orbits", "Orbits", ["q1"], ORBITS));
  writeFileSync(join(root, "astro", "lessons", "0002.json"), page("tides", "Tides", ["q2", "q3"]));
  writeFileSync(join(root, "astro", "lessons", "0003.json"), page("reading", "Reading", []));
  mkdirSync(join(root, "bells", "lessons"), { recursive: true });
  writeFileSync(join(root, "bells", "lessons", "0001.json"), page("hurry", "Bells that can't hurry", ["b1"]));
  mkdirSync(join(root, "broken", "lessons"), { recursive: true });
  writeFileSync(join(root, "broken", "lessons", "0001.json"),
    JSON.stringify({ type: "page", id: "x", title: "X", subtitle: "", children: [{ ref: "missing" }] }));
  server = await startSchool({
    ...process.env, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${join(root, "record")}`,
    SCHOOL_COURSES: ["astro", "bells", "broken"].map((c) => `${c}=${join(root, c)}`).join(","),
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
async function answer(course: string, lesson: string, blockId: string, choiceId: string) {
  const opened = await get(`/api/courses/${course}/lessons/${lesson}`);
  const r = await fetch(server!.url + "/api/answer", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ submissionId: crypto.randomUUID(), encounterId: opened.encounterId, blockId, choiceId, ms: 10 }),
  });
  expect(r.status).toBe(200);
}

const orbits = {
  course: "astro", courseTitle: "Astronomy", trusted: true, started: false,
  lesson: { id: "orbits", title: "Orbits", subtitle: "About Orbits", position: 1, of: 3 },
  question: ORBITS.question, teaser: ORBITS.teaser, figure: ORBITS.figure,
};
const tides = {
  course: "astro", courseTitle: "Astronomy", trusted: true, started: false,
  lesson: { id: "tides", title: "Tides", subtitle: "About Tides", position: 2, of: 3 },
  question: "Tides", teaser: "About Tides", figure: null,
};
const hurry = {
  course: "bells", courseTitle: "bells", trusted: true, started: false,
  lesson: { id: "hurry", title: "Bells that can't hurry", subtitle: "About Bells that can't hurry", position: 1, of: 1 },
  question: "Bells that can't hurry", teaser: "About Bells that can't hurry", figure: null,
};

// One server, one record: the cases run in order.
test("on a fresh record every lesson with a quiz is ahead, in course order; without a hook, its title and subtitle stand in", async () => {
  // A reading lesson (no quizzes) is left out, and so is a course whose lessons can't be read.
  expect(await get("/api/showcase")).toEqual([orbits, tides, hurry]);
});

test("a wrong answer starts nothing; a right one starts the course; a lesson with every quiz right is no longer ahead", async () => {
  await answer("astro", "tides", "q2", "wrong");
  expect((await get("/api/showcase")).map((l: { started: boolean }) => l.started)).toEqual([false, false, false]);
  await answer("astro", "tides", "q2", "right");
  expect(await get("/api/showcase")).toEqual([{ ...orbits, started: true }, { ...tides, started: true }, hurry]);
  await answer("astro", "orbits", "q1", "right");
  expect(await get("/api/showcase")).toEqual([{ ...tides, started: true }, hurry]);
});
