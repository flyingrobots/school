// Migration 0006 at the SQL level: the due-review selector reads and never writes, and a year of
// synthetic history is read with bounded work on PGlite and on a real Postgres through Bun.SQL
// (RFC 2 §5; flyingrobots/school#32). What the selector returns is the contract's
// (server/contract/learning-record.ts); these are the facts the port cannot see.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "./migrate.ts";
import { bunSql } from "../adapters/bunsql.ts";
import { pgliteSql } from "../adapters/pglite.ts";
import type { Sql } from "../adapters/sql.ts";
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

/**
 * The bound, as work rather than time, so it holds on a machine of any speed or load
 * (flyingrobots/school#354): one call may touch at most this many buffer pages for each page the
 * school schema holds, counted by EXPLAIN (ANALYZE, BUFFERS), which counts the pages the function's
 * own statements touch. A year of history touches about 23 per page at REVIEW_LIMIT and 47 at
 * FADED_LIMIT on PGlite, 24 and 49 on Postgres 18. Without the index on exposures by encounter, every
 * cited exposure is found by a scan of all of them: about 175 and 350 per page on both, and six times
 * the time, which this bound fails.
 */
const PAGES_TOUCHED_PER_PAGE = 100;
/** A limit no year of history can fill, so the faded rule is read in full. */
const FADED_LIMIT = 10_000;

type Year = {
  record: LearningRecord;
  count: () => Promise<number>;
  /** The pages the school schema's tables and indexes hold. */
  pages: number;
  /** school_app's connection, which EXPLAIN runs on. */
  sql: Sql;
};

/** The buffer pages one due-review call at `limit` touches, found in the cache or read. */
async function pagesTouched(sql: Sql, limit: number): Promise<number> {
  const [row] = await sql.query<{ "QUERY PLAN": unknown }>(
    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM school.due_review($1, $2, $3, $4, $5)",
    ["c", BLOCKS, END, REVIEW_DELAY_MS, limit],
  );
  const raw = row!["QUERY PLAN"];
  const [plan] = (typeof raw === "string" ? JSON.parse(raw) : raw) as [{ Plan: Record<string, number> }];
  return plan.Plan["Shared Hit Blocks"]! + plan.Plan["Shared Read Blocks"]!;
}

/** The pages the school schema's tables and indexes hold, asked as their owner. */
const SCHEMA_PAGES = `SELECT sum(pg_relation_size(c.oid) / current_setting('block_size')::int)::int AS n
  FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'school' AND c.relkind IN ('r', 'i')`;

async function aYear(name: string, history: () => Promise<Year>) {
  test(`${name}: due review: a year of synthetic history is read touching at most ${PAGES_TOUCHED_PER_PAGE} pages per page of the record, and bounded by the limit`, async () => {
    const { record, count, pages, sql } = await history();
    expect(await count()).toBeGreaterThan(DAYS * 3 * QUIZZES);
    const items = await record.dueReview({ course: "c", blocks: BLOCKS, now: END, delayMs: REVIEW_DELAY_MS, limit: REVIEW_LIMIT });
    expect(items).toHaveLength(REVIEW_LIMIT);
    expect(items.every((x) => x.rule === "due-review/wrong-first-try")).toBe(true);
    const touched = await pagesTouched(sql, REVIEW_LIMIT);
    expect(touched / pages, `${touched} pages touched; the record holds ${pages}`).toBeLessThanOrEqual(PAGES_TOUCHED_PER_PAGE);
  });

  // DR-9F. At REVIEW_LIMIT the weak rules fill the list and school.mastery is never read. At a limit
  // no year of history can fill, the faded rule runs over every settled quiz, so this guards its cost.
  test(`${name}: due review: a year of history at limit ${FADED_LIMIT} reads mastery for every quiz touching at most ${PAGES_TOUCHED_PER_PAGE} pages per page of the record`, async () => {
    const { record, pages, sql } = await history();
    const items = await record.dueReview({ course: "c", blocks: BLOCKS, now: END, delayMs: REVIEW_DELAY_MS, limit: FADED_LIMIT });
    expect(items.length).toBeLessThan(FADED_LIMIT);
    expect(items.some((x) => x.rule === "due-review/faded")).toBe(true);
    const touched = await pagesTouched(sql, FADED_LIMIT);
    expect(touched / pages, `${touched} pages touched; the record holds ${pages}`).toBeLessThanOrEqual(PAGES_TOUCHED_PER_PAGE);
  });
}

aYear("postgres (PGlite)", async () => {
  const db = new PGlite();
  opened.push(db);
  await migrate(db);
  await db.exec(YEAR);
  await db.exec("ANALYZE"); // plans from the year's statistics, as autovacuum would give a real server
  const count = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM school.answers")).rows[0]!.n;
  const n = await count();
  const pages = (await db.query<{ n: number }>(SCHEMA_PAGES)).rows[0]!.n;
  await db.exec("SET ROLE school_app");
  const sql = pgliteSql(db);
  return { record: postgresRecord(sql), count: async () => n, pages, sql };
});

const scratch = scratchPostgres();
describe.skipIf(TEST_POSTGRES_URL === undefined)("Bun.SQL on a real Postgres (SCHOOL_TEST_POSTGRES_URL)", () => {
  aYear("postgres (Bun.SQL)", async () => {
    const { url, sql } = await scratch.fresh();
    const owner = scratch.track(new Bun.SQL(url));
    await owner.unsafe(YEAR);
    await owner.unsafe("ANALYZE"); // now, so autovacuum cannot change the plan between calls
    const pages: number = (await owner.unsafe(SCHEMA_PAGES))[0].n;
    // The record's own connection runs only function calls, so EXPLAIN runs as school_app on the owner's.
    return { record: postgresRecord(sql), count: async () => (await owner.unsafe("SELECT count(*)::int AS n FROM school.answers"))[0].n, pages, sql: bunSql(owner, "school_app") };
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
