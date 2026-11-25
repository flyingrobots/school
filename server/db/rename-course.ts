// Renaming a course in the record (flyingrobots/school#174). A course's name is how the record files
// a learner's progress, and a deployment can change it (the folder a course is mounted at names it
// unless SCHOOL_COURSES does). The record is append-only, so the rename is an operator's act: one
// transaction, as school_owner, under the migrate job's lock, that lifts the append-only trigger on
// each table that names a course, renames, restores the trigger, and checks before committing that
// every count is unchanged and every trigger is enabled. Any failure rolls all of it back, triggers
// included, since ALTER TABLE is transactional.
import type { Connection } from "./migrate.ts";
import { OWNER } from "./migrate.ts";

/** The record tables with a `course` column. Snapshots hold page content and name no course. */
export const COURSE_TABLES = ["encounters", "views", "decision_notes"] as const;
const RECORD_TABLES = ["snapshots", "encounters", "answers", "explanations", "gradings", "views", "exposures", "decision_notes"] as const;

/** The names config.ts accepts for a course. */
const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export type Renamed = { from: string; to: string; rows: Record<(typeof COURSE_TABLES)[number], number> };

export async function renameCourse(db: Connection, from: string, to: string): Promise<Renamed> {
  for (const n of [from, to]) {
    if (!NAME.test(n)) throw new Error(`${JSON.stringify(n)} is not a course name: lowercase letters, digits and hyphens`);
  }
  if (from === to) throw new Error("the course would be renamed to itself");
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: number }>(sql, params)).rows[0]!.n);
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of RECORD_TABLES) out[t] = await count(`SELECT count(*)::int AS n FROM school.${t}`);
    return out;
  };
  const named = async (course: string) => {
    let n = 0;
    for (const t of COURSE_TABLES) n += await count(`SELECT count(*)::int AS n FROM school.${t} WHERE course = $1`, [course]);
    return n;
  };

  await db.exec("BEGIN");
  try {
    await db.exec("SELECT pg_advisory_xact_lock(hashtext('school.migrate_job'))");
    await db.exec(`SET LOCAL ROLE ${OWNER}`);
    if ((await named(from)) === 0) throw new Error(`the record has nothing for course ${JSON.stringify(from)}`);
    if ((await named(to)) > 0) {
      throw new Error(`the record already has course ${JSON.stringify(to)}; renaming ${JSON.stringify(from)} to it would merge two courses`);
    }
    const before = await counts();
    const rows = {} as Renamed["rows"];
    for (const t of COURSE_TABLES) {
      await db.exec(`ALTER TABLE school.${t} DISABLE TRIGGER ${t}_append_only`);
      rows[t] = await count(`WITH r AS (UPDATE school.${t} SET course = $2 WHERE course = $1 RETURNING 1) SELECT count(*)::int AS n FROM r`, [from, to]);
      await db.exec(`ALTER TABLE school.${t} ENABLE TRIGGER ${t}_append_only`);
    }
    const after = await counts();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("the record's row counts changed during the rename");
    const off = await count("SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'school.%' AND tgenabled <> 'O'");
    if (off > 0) throw new Error("a record trigger is not enabled after the rename");
    if ((await named(from)) > 0) throw new Error(`rows still name course ${JSON.stringify(from)}`);
    await db.exec("COMMIT");
    return { from, to, rows };
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}
