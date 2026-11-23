// The Postgres adapter passes the LearningRecord contract on PGlite (flyingrobots/school#46), and
// reaches the record only by calling the functions migration 0001 grants to school_app.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite, type PGliteInterface } from "@electric-sql/pglite";
import { learningRecordContract } from "../contract/learning-record.ts";
import { migrate } from "../db/migrate.ts";
import { pgliteSql } from "./pglite.ts";
import { postgresRecord } from "./postgres.ts";
import { createSchool } from "../core/school.ts";
import type { Sql } from "./sql.ts";
import type { Block } from "../core/model.ts";

setDefaultTimeout(30_000); // PGlite starts a whole Postgres in process.

/** The functions the port calls: every one granted to school_app. */
const PORT_FUNCTIONS = [
  "encounter_answers", "encounter_explanations", "explanation", "last_studied", "lesson_progress", "open_encounter",
  "record_exposure", "record_grading", "record_view", "save_explanation", "submission_aid", "submit",
];

/** A function call and nothing else: no table, no second statement, every argument a parameter. */
const FUNCTION_CALL = new RegExp(`^SELECT \\* FROM school\\.(${PORT_FUNCTIONS.join("|")})\\((\\$\\d+(, \\$\\d+)*)?\\)$`);

/** `sql`, refusing any statement that is not a call of one of the port's functions, and recording each one. */
function functionCallsOnly(sql: Sql, seen: string[] = []): Sql {
  return {
    query: async <T>(text: string, params: readonly unknown[]) => {
      if (!FUNCTION_CALL.test(text)) throw new Error(`not a function call: ${text}`);
      seen.push(text);
      return sql.query<T>(text, params);
    },
  };
}

// Migrating takes seconds; each record is a clone of one migrated database, connected as the app.
let template: Promise<PGlite> | undefined;
const opened: PGliteInterface[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
  await (await template)?.close();
});

async function freshApp(): Promise<PGliteInterface> {
  template ??= (async () => { const db = new PGlite(); await migrate(db); return db; })();
  // Tests in a file run one at a time, so the previous test's database is done with.
  for (const db of opened.splice(0)) await db.close();
  const db = await (await template).clone();
  opened.push(db);
  await db.exec("SET ROLE school_app");
  return db;
}

learningRecordContract("postgres (PGlite)", async () => postgresRecord(functionCallsOnly(pgliteSql(await freshApp()))), { recordsExposures: true });

test("the guard refuses table SQL, so the contract run above proves the adapter issues none", async () => {
  const guarded = functionCallsOnly({ query: async () => [] });
  for (const text of [
    "SELECT * FROM school.answers",
    "INSERT INTO school.views (course, lesson, at) VALUES ($1, $2, $3)",
    "SELECT * FROM school.record_view($1, $2, $3); DELETE FROM school.views",
    "SELECT * FROM school.find_block($1, $2, $3)",
    "SELECT * FROM school.iso($1)",
  ]) await expect(guarded.query(text, [])).rejects.toThrow("not a function call");
  expect(await guarded.query("SELECT * FROM school.record_view($1, $2, $3)", [])).toEqual([]);
});

test("every port method is one call of its function, as school_app", async () => {
  const db = await freshApp();
  expect((await db.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u).toBe("school_app");
  const seen: string[] = [];
  const r = postgresRecord(functionCallsOnly(pgliteSql(db), seen));
  const page: Block = { type: "page", id: "l1", title: "l1", subtitle: "", children: [
    { type: "quiz", id: "q1", q: "?", why: ".", choices: [{ id: "a", text: "A", correct: true }] },
    { type: "explain", id: "e1", prompt: "?", model: ".", sources: [] },
  ] };
  const e = await r.openEncounter({ course: "c", lesson: "l1", page, now: "2026-11-21T10:00:00.000Z", aidTracking: 1 });
  await r.recordExposure({ exposureId: crypto.randomUUID(), encounterId: e.id, blockId: "q1", kind: "hint" }, "2026-11-21T10:00:00.500Z");
  await r.submit({ submissionId: crypto.randomUUID(), encounterId: e.id, blockId: "q1", choiceId: "a", ms: 1 }, "2026-11-21T10:00:01.000Z");
  await r.encounterAnswers(e.id);
  await r.lessonProgress("c");
  await r.lastStudied();
  const id = crypto.randomUUID();
  await r.saveExplanation({ submissionId: id, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, "2026-11-21T10:00:02.000Z");
  await r.recordGrading({ status: "failed", findings: null, error: "down", submissionId: id, rubricVersion: "r", promptVersion: "p",
    adapter: "test", model: null, sources: [], raw: null }, "2026-11-21T10:00:03.000Z");
  await r.explanation(id);
  await r.aid(id);
  await r.encounterExplanations(e.id);
  await r.recordView({ course: "c", lesson: "l1" }, "2026-11-21T10:00:04.000Z");
  expect(seen.map((s) => FUNCTION_CALL.exec(s)![1]).sort()).toEqual(PORT_FUNCTIONS);
});

test("a time keeps its milliseconds and comes back as the model's ISO string", async () => {
  const r = postgresRecord(pgliteSql(await freshApp()));
  const e = await r.openEncounter({ course: "c", lesson: "l1", page: { type: "page", id: "l1", title: "l1", subtitle: "", children: [
    { type: "explain", id: "e1", prompt: "?", model: ".", sources: [] }] }, now: "2026-11-21T10:00:00.000Z", aidTracking: null });
  const id = crypto.randomUUID();
  await r.saveExplanation({ submissionId: id, encounterId: e.id, blockId: "e1", text: "Because.", ms: 1 }, "2026-11-21T10:00:01.234Z");
  const g = await r.recordGrading({ status: "failed", findings: null, error: "down", submissionId: id, rubricVersion: "r", promptVersion: "p",
    adapter: "test", model: null, sources: [], raw: null }, "2026-11-21T10:00:02.567Z");
  expect(g.at).toBe("2026-11-21T10:00:02.567Z");
  expect((await r.explanation(id))?.state.at).toBe("2026-11-21T10:00:01.234Z");
  expect((await r.encounterExplanations(e.id))[0]?.at).toBe("2026-11-21T10:00:01.234Z");
});

test("a value of the wrong shape from the database fails loudly at the adapter", async () => {
  const lying: Sql = { query: async <T>() => [{ id: "x", hash: "h", resumed: "yes" }] as T[] };
  await expect(postgresRecord(lying).openEncounter({ course: "c", lesson: "l", page: { type: "prose", id: "p", html: "" }, now: "2026-11-21T10:00:00.000Z", aidTracking: null }))
    .rejects.toThrow();
  const none: Sql = { query: async <T>() => [] as T[] };
  await expect(postgresRecord(none).submit({ submissionId: crypto.randomUUID(), encounterId: crypto.randomUUID(), blockId: "q", choiceId: "c", ms: 1 },
    "2026-11-21T10:00:00.000Z")).rejects.toThrow("exactly one row");
});

test("the capture version the caller states is the encounter's aid_tracking, and NULL stays NULL", async () => {
  const db = await freshApp();
  const r = postgresRecord(pgliteSql(db));
  const page = (id: string): Block => ({ type: "page", id, title: id, subtitle: "", children: [] });
  await r.openEncounter({ course: "c", lesson: "on", page: page("on"), now: "2026-11-21T10:00:00.000Z", aidTracking: 1 });
  await r.openEncounter({ course: "c", lesson: "off", page: page("off"), now: "2026-11-21T10:00:00.000Z", aidTracking: null });
  await db.exec("RESET ROLE");
  const rows = (await db.query("SELECT lesson, aid_tracking FROM school.encounters ORDER BY seq")).rows;
  expect(rows).toEqual([{ lesson: "on", aid_tracking: 1 }, { lesson: "off", aid_tracking: null }]);
});

test("RFC 2 Figure 4 through the use cases: open tracked, explain, reveal, revise", async () => {
  let tick = 0;
  const clock = { now: () => new Date(Date.parse("2026-11-21T10:00:00.000Z") + 1000 * tick++).toISOString() };
  const grader = { adapter: "none", model: "", rubricVersion: "r", promptVersion: "p", grade: async () => ({ status: "failed", error: "unused" }) as const };
  const school = createSchool({ record: postgresRecord(pgliteSql(await freshApp())), grader, clock });
  const page: Block = { type: "page", id: "l1", title: "l1", subtitle: "", children: [{ type: "explain", id: "e1", prompt: "?", model: ".", sources: [] }] };
  const { encounter } = await school.openLesson("c", page, 1);
  const a = crypto.randomUUID();
  const b = crypto.randomUUID();
  await school.saveExplanation({ submissionId: a, encounterId: encounter.id, blockId: "e1", text: "First go.", ms: 1 });
  expect(await school.submissionAid(a)).toBe("no-recorded-aid");
  expect(await school.recordExposure({ exposureId: crypto.randomUUID(), encounterId: encounter.id, blockId: "e1", kind: "model-answer" }))
    .toEqual({ status: "stored" });
  await school.saveExplanation({ submissionId: b, encounterId: encounter.id, blockId: "e1", text: "Revised.", ms: 1 });
  expect(await school.submissionAid(b)).toBe("aided");
  expect(await school.submissionAid(a)).toBe("no-recorded-aid");
});
