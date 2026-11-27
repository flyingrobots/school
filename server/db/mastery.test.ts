// Migration 0011 at the SQL level: the mastery measure reads and never writes, school_app reaches
// it only as a function, and a long run of clean answers keeps stability a finite number (RFC 5
// §4.1, §4.4; flyingrobots/school#217). What the measure returns is the contract's
// (server/contract/learning-record.ts); these are the facts the port cannot see.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "./migrate.ts";
import { pgliteSql } from "../adapters/pglite.ts";
import { postgresRecord } from "../adapters/postgres.ts";

setDefaultTimeout(60_000); // PGlite starts a whole Postgres in process.

const opened: PGlite[] = [];
afterAll(async () => {
  for (const db of opened) await db.close();
});

async function fresh(): Promise<PGlite> {
  const db = new PGlite();
  opened.push(db);
  await migrate(db);
  return db;
}

const DAY = 24 * 60 * 60 * 1000;
const START = "2026-01-01T09:00:00Z";

/**
 * `n` encounters of a lesson holding quiz q1, one a day, each answered right first try with
 * nothing shown: written through the record's own functions as the superuser in one statement.
 */
const CLEAN_DAYS = (n: number) => `
DO $$
DECLARE
  d int; v_e uuid; v_t timestamptz;
  v_content text := jsonb_build_object('type', 'page', 'id', 'l', 'title', 'L', 'subtitle', '', 'children', jsonb_build_array(
    jsonb_build_object('type', 'quiz', 'id', 'q1', 'q', '?', 'why', '.', 'choices', jsonb_build_array(
      jsonb_build_object('id', 'right', 'text', 'R', 'correct', true), jsonb_build_object('id', 'wrong', 'text', 'W', 'correct', false)))))::text;
BEGIN
  FOR d IN 0..${n - 1} LOOP
    v_t := '${START}'::timestamptz + d * interval '1 day';
    SELECT o.id INTO v_e FROM school.open_encounter('c', 'l', v_content, v_t, 1) o;
    PERFORM school.submit(gen_random_uuid(), v_e, 'q1', 'right', 1000, v_t);
  END LOOP;
END $$`;

test("the measure is read-only: it is STABLE, and calling it takes no sequence value and stores nothing", async () => {
  const db = await fresh();
  await db.exec(CLEAN_DAYS(3));
  const volatility = (await db.query<{ v: string }>("SELECT provolatile AS v FROM pg_proc WHERE proname = 'mastery'")).rows;
  expect(volatility).toEqual([{ v: "s" }]);
  const before = (await db.query<{ v: string }>("SELECT last_value::text AS v FROM school.record_seq")).rows[0]!.v;
  await db.exec("SET ROLE school_app");
  const held = await postgresRecord(pgliteSql(db)).mastery({ course: "c", blocks: ["q1"], now: "2026-01-04T09:00:00.000Z", delayMs: DAY / 2 });
  expect(held).toMatchObject([{ blockId: "q1", stabilityMs: 6.25 * DAY, refreshedAt: "2026-01-03T09:00:00.000Z" }]);
  await db.exec("RESET ROLE");
  expect((await db.query<{ v: string }>("SELECT last_value::text AS v FROM school.record_seq")).rows[0]!.v).toBe(before);
});

test("school_app reaches the measure only as a function, never the tables behind it", async () => {
  const db = await fresh();
  await db.exec("SET ROLE school_app");
  expect((await db.query("SELECT * FROM school.mastery('c', '[\"q1\"]'::jsonb, now(), 1)")).rows).toHaveLength(1);
  await expect(db.query("SELECT seq FROM school.answers")).rejects.toThrow(/permission denied/);
  await expect(db.query("SELECT seq FROM school.exposures")).rejects.toThrow(/permission denied/);
  await expect(db.query("SELECT aid_tracking FROM school.encounters")).rejects.toThrow(/permission denied/);
  await db.exec("RESET ROLE");
  const granted = (await db.query<{ f: string; definer: boolean; path: string[] | null }>(`
    SELECT p.proname AS f, p.prosecdef AS definer, p.proconfig AS path FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'school' AND p.proname = 'mastery' AND has_function_privilege('school_app', p.oid, 'EXECUTE')`)).rows;
  expect(granted).toEqual([{ f: "mastery", definer: true, path: ["search_path=school, pg_temp"] }]);
});

test("stability stops growing after 100 counted answers, so it stays a finite number however long the history", async () => {
  const db = await fresh();
  await db.exec(CLEAN_DAYS(150));
  await db.exec("SET ROLE school_app");
  const [held] = await postgresRecord(pgliteSql(db)).mastery({ course: "c", blocks: ["q1"], now: "2036-01-01T09:00:00.000Z", delayMs: DAY });
  // 149 spaced clean answers after the first; 2.5^100 days is about 10^37 years, so strength is 1 to any precision.
  expect(held!.stabilityMs! / (2.5 ** 100 * DAY)).toBeCloseTo(1, 12);
  expect(held!.strength).toBeCloseTo(1, 10);
  expect(held!.evidence).toHaveLength(100);
});
