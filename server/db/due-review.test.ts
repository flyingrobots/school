// Migration 0005 at the SQL level: the due-review selector reads and never writes, and a year of
// synthetic history is read within a bounded time on PGlite and on a real Postgres through Bun.SQL
// (RFC 2 §5; flyingrobots/school#32). What the selector returns is the contract's
// (server/contract/learning-record.ts); these are the facts the port cannot see.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "./migrate.ts";
import { pgliteSql } from "../adapters/pglite.ts";
import { postgresRecord } from "../adapters/postgres.ts";
import type { LearningRecord } from "../core/ports.ts";
import { REVIEW_DELAY_MS, REVIEW_LIMIT } from "../core/school.ts";
import { scratchPostgres, TEST_POSTGRES_URL } from "../testing/postgres.ts";

setDefaultTimeout(120_000);

const opened: PGlite[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
});

const LESSONS = 40;
const QUIZZES = 8;
const DAYS = 365;
const START = "2025-11-22T07:00:00Z";
/** Where the year ends: the morning after its last study session. */
const END = new Date(Date.parse(START) + DAYS * 24 * 3600 * 1000).toISOString();
const BLOCKS = Array.from({ length: LESSONS * QUIZZES }, (_, i) => `l${Math.floor(i / QUIZZES)}q${i % QUIZZES}`);

/**
 * A year of study, written through the record's own functions as the superuser in one statement:
 * three sessions a day, each a lesson of eight quizzes, a third of them wrong first, with feedback
 * shown and then the right answer; one session in ten on an old client School was not watching.
 */
const YEAR = `
DO $$
DECLARE
  d int; s int; l int; q int; v_e uuid; v_t timestamptz; v_content text; v_block text;
BEGIN
  FOR d IN 0..${DAYS - 1} LOOP
    FOR s IN 0..2 LOOP
      l := (d * 3 + s) % ${LESSONS};
      v_t := '${START}'::timestamptz + d * interval '1 day' + s * interval '3 hours';
      v_content := jsonb_build_object('type', 'page', 'id', 'l' || l, 'title', 'L', 'subtitle', '', 'children',
        (SELECT jsonb_agg(jsonb_build_object('type', 'quiz', 'id', 'l' || l || 'q' || k, 'q', '?', 'why', '.',
           'choices', jsonb_build_array(jsonb_build_object('id', 'right', 'text', 'R', 'correct', true),
                                        jsonb_build_object('id', 'wrong', 'text', 'W', 'correct', false))))
         FROM generate_series(0, ${QUIZZES - 1}) k))::text;
      SELECT o.id INTO v_e FROM school.open_encounter('c', 'l' || l, v_content, v_t, CASE WHEN (d + s) % 10 = 0 THEN NULL ELSE 1 END) o;
      FOR q IN 0..${QUIZZES - 1} LOOP
        v_block := 'l' || l || 'q' || q;
        v_t := v_t + interval '1 minute';
        IF (d * 7 + s * 3 + q) % 3 = 0 THEN
          PERFORM school.submit(gen_random_uuid(), v_e, v_block, 'wrong', 1000, v_t);
          PERFORM school.record_exposure(gen_random_uuid(), v_e, v_block, 'feedback', v_t + interval '1 second');
        END IF;
        PERFORM school.submit(gen_random_uuid(), v_e, v_block, 'right', 1000, v_t + interval '2 seconds');
      END LOOP;
    END LOOP;
  END LOOP;
END $$`;

/** The bound: generous for a loaded CI machine, far below what a lesson open can afford to wait. */
const BOUND_MS = 1000;

async function aYear(name: string, history: () => Promise<{ record: LearningRecord; count: () => Promise<number> }>) {
  test(`${name}: due review: a year of synthetic history is read within ${BOUND_MS} ms, and bounded by the limit`, async () => {
    const { record, count } = await history();
    expect(await count()).toBeGreaterThan(DAYS * 3 * QUIZZES);
    const ask = () => record.dueReview({ course: "c", blocks: BLOCKS, now: END, delayMs: REVIEW_DELAY_MS, limit: REVIEW_LIMIT });
    await ask(); // the first call plans the query
    const times: number[] = [];
    let items: Awaited<ReturnType<typeof ask>> = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      items = await ask();
      times.push(performance.now() - t);
    }
    expect(items).toHaveLength(REVIEW_LIMIT);
    expect(items.every((x) => x.rule === "due-review/wrong-first-try")).toBe(true);
    expect(Math.min(...times)).toBeLessThan(BOUND_MS);
  });
}

aYear("postgres (PGlite)", async () => {
  const db = new PGlite();
  opened.push(db);
  await migrate(db);
  await db.exec(YEAR);
  const count = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM school.answers")).rows[0]!.n;
  const n = await count();
  await db.exec("SET ROLE school_app");
  return { record: postgresRecord(pgliteSql(db)), count: async () => n };
});

const scratch = scratchPostgres();
describe.skipIf(TEST_POSTGRES_URL === undefined)("Bun.SQL on a real Postgres (SCHOOL_TEST_POSTGRES_URL)", () => {
  aYear("postgres (Bun.SQL)", async () => {
    const { url, sql } = await scratch.fresh();
    const owner = scratch.track(new Bun.SQL(url));
    await owner.unsafe(YEAR);
    return { record: postgresRecord(sql), count: async () => (await owner.unsafe("SELECT count(*)::int AS n FROM school.answers"))[0].n };
  });
});

test("the selector is read-only: it is STABLE, and calling it takes no sequence value and stores nothing", async () => {
  const db = new PGlite();
  opened.push(db);
  await migrate(db);
  await db.exec(YEAR.replace(`FOR d IN 0..${DAYS - 1} LOOP`, "FOR d IN 0..2 LOOP"));
  const volatility = (await db.query<{ v: string }>("SELECT provolatile AS v FROM pg_proc WHERE proname = 'due_review'")).rows;
  expect(volatility).toEqual([{ v: "s" }]);
  const before = (await db.query<{ v: string }>("SELECT last_value::text AS v FROM school.record_seq")).rows[0]!.v;
  await db.exec("SET ROLE school_app");
  const due = await postgresRecord(pgliteSql(db)).dueReview({ course: "c", blocks: BLOCKS, now: END, delayMs: REVIEW_DELAY_MS, limit: 50 });
  expect(due.length).toBeGreaterThan(0);
  await db.exec("RESET ROLE");
  expect((await db.query<{ v: string }>("SELECT last_value::text AS v FROM school.record_seq")).rows[0]!.v).toBe(before);
});

test("school_app reaches the selector and the review open only as functions, never the tables behind them", async () => {
  const db = new PGlite();
  opened.push(db);
  await migrate(db);
  await db.exec("SET ROLE school_app");
  await db.query("SELECT * FROM school.due_review('c', '[]'::jsonb, now(), 1, 1)");
  await expect(db.query("SELECT lesson_hash FROM school.encounters")).rejects.toThrow(/permission denied/);
  await db.exec("RESET ROLE");
  const granted = (await db.query<{ f: string }>(`
    SELECT p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'school' AND p.proname IN ('due_review', 'open_lesson_encounter') AND has_function_privilege('school_app', p.oid, 'EXECUTE')
    ORDER BY 1`)).rows.map((r) => r.f);
  expect(granted).toEqual(["due_review", "open_lesson_encounter"]);
});
