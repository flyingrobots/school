// How each course is holding, on the home page's timeline (RFC 5 Table 5.1 step 6;
// flyingrobots/school#222), over HTTP against the real server process: GET /api/activity gives each
// course's mastery counts for today, and a quiz that will fade comes back as a ring on its day.
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
const rocks = { type: "page", id: "rocks", title: "Rocks", subtitle: "", children: ["g1", "g2", "g3"].map(quiz) } satisfies Block;
const seeds = { type: "page", id: "seeds", title: "Seeds", subtitle: "", children: [quiz("b1")] } satisfies Block;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
// Every seed is relative to now, so read days in a fixed-offset zone where it is about midday now:
// three days ahead is then one local day whatever the time this runs (as web/test/home.test.ts does).
// Etc/GMT signs are inverted.
const TZ = (() => {
  const h = 12 - new Date(NOW).getUTCHours();
  return h === 0 ? "Etc/UTC" : `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`;
})();
const dayIn = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "school-activity-mastery-"));
  for (const [name, title, page] of [["geo", "Geology", rocks], ["bot", "Botany", seeds]] as const) {
    mkdirSync(join(root, name, "lessons"), { recursive: true });
    writeFileSync(join(root, name, "course.json"), JSON.stringify({ title }));
    writeFileSync(join(root, name, "lessons", "0001.json"), JSON.stringify(page));
  }
  // Each quiz's state, from RFC 5 §4.1 and Table 4.5 (docs/topics/mastery/README.md):
  //   g1 clean two days ago: stability one day, strength 0.5^2 = 0.25 now, so faded today, and due
  //      now rather than a ring ahead.
  //   g2 clean three days ago, then clean again an hour ago, more than the 20-hour delay later: one
  //      spaced clean episode after the anchor, stability 2.5 days, refreshed an hour ago. Strength
  //      is 0.5^(25/60) = 0.75 a day ahead and 0.5^(49/60) = 0.57 two days ahead, both holding, and
  //      0.5^(73/60) = 0.43 three days ahead: faded, so it comes back three days ahead.
  //   g3 never answered: not started.
  // Botany's one quiz is never answered: a course not started.
  const dir = join(root, "record");
  const db = await openDatabase({ driver: "pglite", dir });
  const r = postgresRecord(db.sql);
  const answer = async (blockId: string, when: number) => {
    const e = await r.openEncounter({ course: "geo", lesson: "rocks", page: rocks, now: ago(when + 1000), aidTracking: 1 });
    await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId, choiceId: "right", ms: 10 }, ago(when));
  };
  await answer("g2", 3 * DAY);
  await answer("g1", 2 * DAY);
  await answer("g2", HOUR);
  await db.close();
  server = await startSchool({
    ...process.env, TZ, HOST: "127.0.0.1", SCHOOL_STATE: join(root, "state"), SCHOOL_WEB: join(root, "no-web"),
    SCHOOL_DATABASE_URL: `pglite:${dir}`, SCHOOL_COURSES: `geo=${join(root, "geo")},bot=${join(root, "bot")}`,
  });
}, timeout(1));
afterAll(async () => {
  server?.proc.kill();
  await server?.proc.exited;
  if (root) rmSync(root, { recursive: true, force: true });
});

type Lane = { course: string; quizzes: number; mastery: Record<string, number>; due: { day: string; items: number }[] };
const lanes = async (): Promise<Lane[]> => {
  const r = await fetch(`${server!.url}/api/activity?days=14&tz=${encodeURIComponent(TZ)}`);
  expect(r.status).toBe(200);
  return (await r.json()).courses;
};
const lane = async (course: string) => (await lanes()).find((c) => c.course === course)!;

test("a course with one faded quiz counts it, beside the quizzes holding and not started, today", async () => {
  // Oracle: the states worked above. Read at a projected day instead of today, g2 would be faded too.
  expect(await lane("geo")).toMatchObject({ quizzes: 3, mastery: { notStarted: 1, settling: 0, holding: 1, faded: 1 } });
});

test("a quiz that fades comes back as a ring on the day its strength falls below one half, not before", async () => {
  // Oracle: g2 above, faded three days ahead and not two. g1, faded already, is due now and is no ring.
  expect((await lane("geo")).due).toEqual([{ day: dayIn(NOW + 3 * DAY), items: 1 }]);
});

test("a course not started counts every quiz as not started, with no ring ahead", async () => {
  expect(await lane("bot")).toMatchObject({ quizzes: 1, mastery: { notStarted: 1, settling: 0, holding: 0, faded: 0 }, due: [] });
});

test("the rollup's mean strength is not in the response", async () => {
  const all = await lanes();
  expect(all.map((c) => c.course)).toEqual(["geo", "bot"]);
  for (const c of all) expect(Object.keys(c.mastery).sort()).toEqual(["faded", "holding", "notStarted", "settling"]);
});
