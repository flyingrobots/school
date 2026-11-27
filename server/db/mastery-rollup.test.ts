// Migration 0013 at the SQL level: the mastery rollup reads and never writes, and school_app reaches
// it only as a function (RFC 5 §4.4, §4.5; flyingrobots/school#218). What the rollup returns is the
// contract's (server/contract/learning-record.ts); these are the facts the port cannot see.
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

/** One encounter of a lesson holding quiz q1, answered right first try with nothing shown, through the record's own functions. */
const CLEAN = `
DO $$
DECLARE
  v_e uuid;
  v_content text := jsonb_build_object('type', 'page', 'id', 'l', 'title', 'L', 'subtitle', '', 'children', jsonb_build_array(
    jsonb_build_object('type', 'quiz', 'id', 'q1', 'q', '?', 'why', '.', 'choices', jsonb_build_array(
      jsonb_build_object('id', 'right', 'text', 'R', 'correct', true), jsonb_build_object('id', 'wrong', 'text', 'W', 'correct', false)))))::text;
BEGIN
  SELECT o.id INTO v_e FROM school.open_encounter('c', 'l', v_content, '2026-01-01T09:00:00Z', 1) o;
  PERFORM school.submit(gen_random_uuid(), v_e, 'q1', 'right', 1000, '2026-01-01T09:00:00Z');
END $$`;

test("the rollup is read-only: it is STABLE, and calling it takes no sequence value and stores nothing", async () => {
  const db = await fresh();
  await db.exec(CLEAN);
  const volatility = (await db.query<{ v: string }>("SELECT provolatile AS v FROM pg_proc WHERE proname = 'mastery_rollup'")).rows;
  expect(volatility).toEqual([{ v: "s" }]);
  const before = (await db.query<{ v: string }>("SELECT last_value::text AS v FROM school.record_seq")).rows[0]!.v;
  await db.exec("SET ROLE school_app");
  const rows = await postgresRecord(pgliteSql(db)).masteryRollup({ course: "c", groups: { l: ["q1"] }, now: "2026-01-01T09:00:00.000Z", delayMs: 1 });
  expect(rows).toEqual([{ key: "l", quizzes: 1, notStarted: 0, settling: 0, holding: 1, faded: 0, strength: 1 }]);
  await db.exec("RESET ROLE");
  expect((await db.query<{ v: string }>("SELECT last_value::text AS v FROM school.record_seq")).rows[0]!.v).toBe(before);
});

test("school_app reaches the rollup only as a function: SECURITY DEFINER with search_path fixed", async () => {
  const db = await fresh();
  await db.exec("SET ROLE school_app");
  expect((await db.query("SELECT * FROM school.mastery_rollup('c', '{\"l\": [\"q1\"]}'::jsonb, now(), 1)")).rows).toHaveLength(1);
  await db.exec("RESET ROLE");
  const granted = (await db.query<{ f: string; definer: boolean; path: string[] | null }>(`
    SELECT p.proname AS f, p.prosecdef AS definer, p.proconfig AS path FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'school' AND p.proname = 'mastery_rollup' AND has_function_privilege('school_app', p.oid, 'EXECUTE')`)).rows;
  expect(granted).toEqual([{ f: "mastery_rollup", definer: true, path: ["search_path=school, pg_temp"] }]);
});

test("groups that are not a jsonb object ask about nothing, and a group that is not an array is empty", async () => {
  const db = await fresh();
  await db.exec("SET ROLE school_app");
  const call = async (groups: string) =>
    (await db.query<{ item: unknown }>(`SELECT item FROM school.mastery_rollup('c', '${groups}'::jsonb, now(), 1)`)).rows.map((r) => r.item);
  expect(await call("[\"q1\"]")).toEqual([]);
  expect(await call("null")).toEqual([]);
  expect(await call("{\"l\": \"q1\"}")).toEqual([{ key: "l", quizzes: 0, notStarted: 0, settling: 0, holding: 0, faded: 0, strength: null }]);
  await db.exec("RESET ROLE");
});
