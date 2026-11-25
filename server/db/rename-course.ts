// Renaming a course in the record (flyingrobots/school#174). A course's name is how the record files
// a learner's progress, and a deployment can change it (the folder a course is mounted at names it
// unless SCHOOL_COURSES does). The record is append-only, so the rename is an operator's act, with
// School stopped: it refuses while any school_app session is open, because a running server would
// go on writing under the old name. It is one transaction, as school_owner, holding both of the
// migrate job's advisory locks (the runner's and the role step's), that first locks every record
// table against writes, then checks, lifts the append-only trigger on each table that names a
// course, renames, restores the trigger, and checks before committing that every count is unchanged
// and every trigger is enabled. Any failure rolls all of it back, triggers included, since ALTER
// TABLE is transactional.
import { NAME, RESERVED } from "../config.ts";
import type { Connection } from "./migrate.ts";
import { OWNER } from "./migrate.ts";

/** The record tables with a `course` column. Snapshots hold page content and name no course. */
export const COURSE_TABLES = ["encounters", "views", "decision_notes"] as const;
const RECORD_TABLES = ["snapshots", "encounters", "answers", "explanations", "gradings", "views", "exposures", "decision_notes"] as const;

export type Renamed = { from: string; to: string; rows: Record<(typeof COURSE_TABLES)[number], number> };

/** Why `name` cannot name a course, by the rules config.ts applies, or null if it can. */
export function badCourseName(name: string): string | null {
  if (!NAME.test(name)) return `${JSON.stringify(name)} is not a course name: a lowercase letter or digit, then lowercase letters, digits and hyphens`;
  if ((RESERVED as readonly string[]).includes(name)) return `${JSON.stringify(name)} is reserved and cannot name a course`;
  return null;
}

export async function renameCourse(db: Connection, from: string, to: string): Promise<Renamed> {
  for (const n of [from, to]) {
    const bad = badCourseName(n);
    if (bad !== null) throw new Error(bad);
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
    await db.exec("SELECT pg_advisory_xact_lock(hashtext('school.schema_migrations'))");
    await db.exec("SELECT pg_advisory_xact_lock(hashtext('school.migrate_job'))");
    const sessions = await count("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'school_app' AND datname = current_database()");
    if (sessions > 0) {
      throw new Error(`School is connected to the record (${sessions} school_app session${sessions === 1 ? "" : "s"}); stop it first: ./school compose stop school`);
    }
    await db.exec(`SET LOCAL ROLE ${OWNER}`);
    // Writes wait from here until COMMIT, so nothing lands between the checks and the rename.
    await db.exec(`LOCK TABLE ${RECORD_TABLES.map((t) => `school.${t}`).join(", ")} IN EXCLUSIVE MODE`);
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
