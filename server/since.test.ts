// What happened since the learner was last here (flyingrobots/school#165), over HTTP against the
// real server process: the latest feedback, the questions ready for another look across courses, and
// the days studied and the days questions come back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./adapters/database.ts";
import { postgresRecord } from "./adapters/postgres.ts";
import type { Block, GradingRecord } from "./core/model.ts";
import { startSchool, timeout, type Started } from "./testing/processes.ts";

const TZ = "Pacific/Auckland";
let root = "";
let server: Started | null = null;
let empty: Started | null = null;

const quiz = (id: string): Block => ({
  type: "quiz", id, q: `Question ${id}?`, why: "Because.",
  choices: [{ id: "wrong", text: "Wrong one", correct: false }, { id: "right", text: "Right one", correct: true }],
});
const explain: Block = { type: "explain", id: "e1", prompt: "How would you say why?", model: "Because.", sources: [] };
const page = (id: string, title: string, children: Block[]): Block => ({ type: "page", id, title, subtitle: "", children });
const l1 = page("l1", "Orbits", [quiz("q1"), quiz("q2"), explain]);
const l2 = page("l2", "Tides", [quiz("q3")]);
const NOW = Date.now();
const HOUR = 3600 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const dayIn = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const findings: NonNullable<GradingRecord["findings"]> = {
  insufficient_evidence: false, summary: "Good start.", contradictions: [],
  fidelity: { verdict: "meets", note: "Right idea." }, completeness: { verdict: "partly", note: "One more step." },
  accessibility: { verdict: "meets", note: "Plain words." },
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-since-"));
  mkdirSync(join(root, "c", "lessons"), { recursive: true });
  writeFileSync(join(root, "c", "course.json"), JSON.stringify({ title: "Astronomy" }));
  writeFileSync(join(root, "c", "lessons", "0001.json"), JSON.stringify(l1));
  writeFileSync(join(root, "c", "lessons", "0002.json"), JSON.stringify(l2));
  mkdirSync(join(root, "d", "lessons"), { recursive: true });
  writeFileSync(join(root, "d", "lessons", "0001.json"), JSON.stringify(page("m1", "Bells", [quiz("b1")])));
  const dir = join(root, "record");
  const db = await openDatabase({ driver: "pglite", dir });
  const r = postgresRecord(db.sql);
  // Two days ago: q1 wrong then right, which is due now; an explanation, graded.
  const e = await r.openEncounter({ course: "c", lesson: "l1", page: l1, now: ago(48 * HOUR), aidTracking: 1 });
  await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "q1", choiceId: "wrong", ms: 10 }, ago(48 * HOUR - 1000));
  await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "q1", choiceId: "right", ms: 10 }, ago(48 * HOUR - 2000));
  const sub = crypto.randomUUID();
  await r.saveExplanation({ submissionId: sub, encounterId: e.id, blockId: "e1", text: "Because it is.", ms: 10 }, ago(48 * HOUR - 3000));
  await r.recordGrading({ status: "succeeded", error: null, submissionId: sub, rubricVersion: "r", promptVersion: "p", adapter: "test",
    model: "claude", sources: [], raw: "{}", findings }, ago(48 * HOUR - 4000));
  // Ten hours ago: q2 wrong then right, in a new encounter. Not due yet; due within a day.
  const e2 = await r.openEncounter({ course: "c", lesson: "l1", page: l1, now: ago(10 * HOUR), aidTracking: 1 });
  await r.submit({ submissionId: crypto.randomUUID(), encounterId: e2.id, blockId: "q2", choiceId: "wrong", ms: 10 }, ago(10 * HOUR - 1000));
  await r.submit({ submissionId: crypto.randomUUID(), encounterId: e2.id, blockId: "q2", choiceId: "right", ms: 10 }, ago(10 * HOUR - 2000));
  await db.close();
  const env = { ...process.env, HOST: "127.0.0.1", SCHOOL_WEB: join(root, "no-web"), TZ };
  const courses = ["c", "d"].map((c) => `${c}=${join(root, c)}`).join(",");
  server = await startSchool({ ...env, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: `pglite:${dir}`, SCHOOL_COURSES: courses });
  empty = await startSchool({ ...env, SCHOOL_STATE: join(root, "state2"), SCHOOL_DATABASE_URL: `pglite:${join(root, "record2")}`, SCHOOL_COURSES: courses });
}, timeout(2));
afterAll(async () => {
  for (const s of [server, empty]) {
    s?.proc.kill();
    await s?.proc.exited;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

const get = async (s: Started | null, path: string, status = 200) => {
  const r = await fetch(s!.url + path);
  expect(r.status).toBe(status);
  return r.json();
};

test("an empty record has no feedback, nothing to review, and no days studied", async () => {
  expect(await get(empty, "/api/feedback")).toBeNull();
  expect(await get(empty, "/api/review")).toEqual([]);
  const activity = await get(empty, "/api/activity?days=14");
  expect(activity).toEqual({
    today: dayIn(Date.now()), tz: TZ, days: 14,
    courses: [
      { course: "c", courseTitle: "Astronomy", trusted: true, studied: [], due: [], quizzes: 3, mastery: { notStarted: 3, settling: 0, holding: 0, faded: 0 } },
      { course: "d", courseTitle: "d", trusted: true, studied: [], due: [], quizzes: 1, mastery: { notStarted: 1, settling: 0, holding: 0, faded: 0 } },
    ],
  });
});

test("the latest feedback names its course, lesson and prompt, with the grader's findings", async () => {
  expect(await get(server, "/api/feedback")).toEqual({
    course: "c", courseTitle: "Astronomy", trusted: true, lesson: { id: "l1", title: "Orbits" }, blockId: "e1",
    prompt: "How would you say why?", model: "claude", findings, at: ago(48 * HOUR - 4000),
  });
});

test("questions ready for another look name their course and lesson, the question, and why, in School's voice", async () => {
  const review = await get(server, "/api/review");
  expect(review).toEqual([{
    course: "c", courseTitle: "Astronomy", trusted: true, lesson: { id: "l1", title: "Orbits" }, blockId: "q1", question: "Question q1?",
    answeredAt: ago(48 * HOUR - 1000), rule: "due-review/wrong-first-try", reason: expect.stringContaining("you found this one on a second go"),
  }]);
  // A course with no answers sends nothing back.
  expect(review.some((x: { course: string }) => x.course === "d")).toBe(false);
});

test("activity lists each course's study days in the window, and how many questions come back on each day ahead", async () => {
  const a = await get(server, "/api/activity?days=14");
  expect(a.today).toBe(dayIn(Date.now()));
  const c = a.courses.find((x: { course: string }) => x.course === "c");
  expect(c.studied).toEqual([...new Set([dayIn(NOW - 48 * HOUR), dayIn(NOW - 10 * HOUR)])]);
  // q1 is due now, so it is not ahead; q2 comes back within the next day.
  expect(c.due).toEqual([{ day: dayIn(NOW + 24 * HOUR), items: 1 }]);
  expect(a.courses.find((x: { course: string }) => x.course === "d")).toEqual({
    course: "d", courseTitle: "d", trusted: true, studied: [], due: [], quizzes: 1, mastery: { notStarted: 1, settling: 0, holding: 0, faded: 0 },
  });
  // days is bounded, and must be a whole number.
  for (const bad of ["0", "61", "x", "1.5"]) await get(server, `/api/activity?days=${bad}`, 400);
  expect((await get(server, "/api/activity")).days).toBe(14);
});

// The learner's zone, not the server's (flyingrobots/school#178): the page sends its own as `tz`.
const dayOf = (ms: number, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const wordsOf = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "long" }).format(new Date(ms));

test("activity reads days in the zone the page sends, and refuses one that is not a zone", async () => {
  for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
    const a = await get(server, `/api/activity?days=14&tz=${encodeURIComponent(tz)}`);
    expect({ tz: a.tz, today: a.today }).toEqual({ tz, today: dayOf(Date.now(), tz) });
    const c = a.courses.find((x: { course: string }) => x.course === "c");
    expect(c.studied).toEqual([...new Set([dayOf(NOW - 48 * HOUR + 3000, tz), dayOf(NOW - 10 * HOUR + 2000, tz)])]);
  }
  for (const bad of ["Not/AZone", "", "../etc", "x".repeat(200)]) await get(server, `/api/activity?tz=${encodeURIComponent(bad)}`, 400);
});

test("a question's reason names the day it was answered in the zone the page sends", async () => {
  const at = NOW - 48 * HOUR + 1000;
  const reasons = await Promise.all(["Pacific/Kiritimati", "Pacific/Pago_Pago"].map(async (tz) =>
    (await get(server, `/api/review?tz=${encodeURIComponent(tz)}`))[0].reason as string));
  expect(reasons[0]).toStartWith(`On ${wordsOf(at, "Pacific/Kiritimati")},`);
  expect(reasons[1]).toStartWith(`On ${wordsOf(at, "Pacific/Pago_Pago")},`);
  expect(reasons[0]).not.toBe(reasons[1]);
  await get(server, "/api/review?tz=Not%2FAZone", 400);
});

// A zone chosen in Settings wins over the browser's (flyingrobots/school#181).
test("a time zone chosen in Settings wins over the one the page sends, until set back to automatic", async () => {
  const put = (zone: unknown) => fetch(server!.url + "/api/settings/time-zone", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ zone }),
  });
  expect(await get(server, "/api/settings/time-zone")).toEqual({ zone: null });
  expect((await put("Pacific/Kiritimati")).status).toBe(200);
  expect(await get(server, "/api/settings/time-zone")).toEqual({ zone: "Pacific/Kiritimati" });
  const a = await get(server, `/api/activity?days=14&tz=${encodeURIComponent("Pacific/Pago_Pago")}`);
  expect({ tz: a.tz, today: a.today }).toEqual({ tz: "Pacific/Kiritimati", today: dayOf(Date.now(), "Pacific/Kiritimati") });
  const reason = (await get(server, "/api/review?tz=Pacific%2FPago_Pago"))[0].reason as string;
  expect(reason).toStartWith(`On ${wordsOf(NOW - 48 * HOUR + 1000, "Pacific/Kiritimati")},`);
  for (const bad of ["Not/AZone", "", 5, "x".repeat(200)]) expect((await put(bad)).status).toBe(400);
  expect((await fetch(server!.url + "/api/settings/time-zone", { method: "PUT", body: JSON.stringify({ zone: "UTC" }) })).status).toBe(415);
  expect((await put(null)).status).toBe(200);
  expect(await get(server, "/api/settings/time-zone")).toEqual({ zone: null });
  expect((await get(server, "/api/activity?days=14&tz=Pacific%2FPago_Pago")).tz).toBe("Pacific/Pago_Pago");
});
