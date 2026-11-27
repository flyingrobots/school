// Renaming a course in the record (flyingrobots/school#174), on PGlite: every row naming the old
// course names the new one, nothing else changes, and the append-only guards are back on.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "./migrate.ts";
import { renameCourse } from "./rename-course.ts";

const SLOW = 30_000;
const TABLES = ["encounters", "views", "decision_notes", "conversations"] as const;
const PAGE = JSON.stringify({
  type: "page", id: "l1", title: "l1", subtitle: "",
  children: [{ type: "quiz", id: "q1", q: "Which?", why: "Because.",
    choices: [{ id: "wrong", text: "Wrong", correct: false }, { id: "right", text: "Right", correct: true }] }],
});
const at = (ms = 0) => new Date(Date.parse("2001-02-03T04:05:06.789Z") + ms).toISOString();

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}

async function error(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return (e as Error).message; }
  return "no error";
}

/** A record with two courses, `course` and `bells`, written through the functions as the application. */
async function populated(): Promise<PGlite> {
  const db = new PGlite();
  await migrate(db);
  await as(db, "school_app", async () => {
    for (const [course, ms] of [["course", 0], ["bells", 100]] as const) {
      const e = (await db.query<{ id: string }>("SELECT * FROM school.open_encounter($1, 'l1', $2, $3, 1)", [course, PAGE, at(ms)])).rows[0]!;
      await db.query("SELECT * FROM school.submit($1, $2, 'q1', 'wrong', 1, $3)", [crypto.randomUUID(), e.id, at(ms + 1)]);
      await db.query("SELECT school.record_view($1, 'l1', $2)", [course, at(ms + 2)]);
      const evidence = (await db.query<{ seq: number }>("SELECT seq FROM school.encounter_evidence($1)", [e.id])).rows.map((r) => Number(r.seq));
      await db.query("SELECT * FROM school.record_decision_note($1, $2, 'l1', 'q1', $3, 'due-review/wrong-first-try', 'Because.', $4, $5)",
        [crypto.randomUUID(), course, e.id, JSON.stringify(evidence), at(ms + 3)]);
      // A question about a passage: a conversation naming the course, and its question and reply (RFC 6 §5.2).
      const question = crypto.randomUUID();
      await db.query("SELECT school.ask($1, $2, $3, 'q1', 'Which?', 'Why?', $4)", [crypto.randomUUID(), question, e.id, at(ms + 4)]);
      await db.query("SELECT school.record_reply($1, 'succeeded', 'Because.', '[]', 'a', NULL, NULL, NULL, $2)", [question, at(ms + 5)]);
    }
  });
  return db;
}

const INSTALL_TABLES = ["course_installs", "course_removals"] as const;
const install = async (db: PGlite, course: string, ms: number) => {
  const id = crypto.randomUUID();
  await db.query("SELECT school.install_course($1, $2, 'git', 'https://example.com/c.git', NULL, $3, $4, 'C', 1, $5)",
    [id, course, "a".repeat(40), "c".repeat(64), at(ms)]);
  return id;
};

/**
 * `populated()` plus installs (RFC 7 §7): `course` installed, trusted, removed and installed again,
 * trusted again; `bells` installed once. Returns the current install of `course`.
 */
async function withInstalls(): Promise<{ db: PGlite; current: string }> {
  const db = await populated();
  const current = await as(db, "school_app", async () => {
    const first = await install(db, "course", 200);
    await db.query("SELECT school.choose_course_trust($1, true, $2)", [first, at(201)]);
    await db.query("SELECT school.remove_installed_course('course', $1)", [at(202)]);
    const again = await install(db, "course", 203);
    await db.query("SELECT school.choose_course_trust($1, true, $2)", [again, at(204)]);
    await install(db, "bells", 205);
    return again;
  });
  return { db, current };
}

const installed = (db: PGlite) => as(db, "school_app", async () =>
  (await db.query<{ id: string; course: string; trusted: boolean }>("SELECT id, course, trusted FROM school.installed_courses()")).rows);

/** Each table's rows per course, and every row of every record table, as the owner sees them. */
async function snapshot(db: PGlite) {
  return as(db, "school_owner", async () => {
    const perCourse: Record<string, unknown[]> = {};
    for (const t of TABLES) perCourse[t] = (await db.query(`SELECT course, count(*)::int AS n FROM school.${t} GROUP BY 1 ORDER BY 1`)).rows;
    const all: Record<string, unknown[]> = {};
    for (const t of ["snapshots", "encounters", "answers", "explanations", "gradings", "views", "exposures", "decision_notes", "time_zone_choices",
      ...INSTALL_TABLES, "course_trust_choices", "conversations", "questions", "replies"]) {
      all[t] = (await db.query(`SELECT * FROM school.${t} ORDER BY seq`)).rows;
    }
    return { perCourse, all };
  });
}

const enabled = async (db: PGlite) =>
  (await db.query<{ tgname: string; tgenabled: string }>(`SELECT t.tgname, t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND n.nspname = 'school' ORDER BY 1`)).rows;
const canLogin = async (db: PGlite) => (await db.query<{ l: boolean }>("SELECT rolcanlogin AS l FROM pg_roles WHERE rolname = 'school_app'")).rows[0]!.l;

describe("renameCourse", () => {
  test("moves every row of the old course to the new name, and nothing else", async () => {
    const db = await populated();
    const before = await snapshot(db);
    const triggers = await enabled(db);
    expect(await renameCourse(db, "course", "aion")).toEqual({ from: "course", to: "aion",
      rows: { encounters: 1, views: 1, decision_notes: 1, course_installs: 0, course_removals: 0, conversations: 1 } });
    const after = await snapshot(db);
    for (const t of TABLES) {
      expect(after.perCourse[t]).toEqual([{ course: "aion", n: 1 }, { course: "bells", n: 1 }]);
      const strip = (rows: unknown[]) => rows.map((r) => ({ ...(r as object), course: undefined }));
      expect(strip(after.all[t]!)).toEqual(strip(before.all[t]!));
    }
    for (const t of ["snapshots", "answers", "explanations", "gradings", "exposures", "questions", "replies"]) expect(after.all[t]).toEqual(before.all[t]);
    expect(triggers.length).toBe(30); // two per record table: append-only, and no truncate
    expect(await enabled(db)).toEqual(triggers);
  }, SLOW);

  // RFC 7 §5.2, step 5 (flyingrobots/school#232): an installed course's name is in its install rows.
  test("moves a course's install and removal rows to the new name, and nothing else", async () => {
    const { db, current } = await withInstalls();
    const before = await snapshot(db);
    expect((await renameCourse(db, "course", "aion")).rows).toEqual({ encounters: 1, views: 1, decision_notes: 1, course_installs: 2, course_removals: 1, conversations: 1 });
    const after = await snapshot(db);
    const courses = (rows: unknown[]) => rows.map((r) => (r as { course: string }).course);
    expect(courses(after.all.course_installs!)).toEqual(["aion", "aion", "bells"]);
    expect(courses(after.all.course_removals!)).toEqual(["aion"]);
    for (const t of INSTALL_TABLES) {
      const strip = (rows: unknown[]) => rows.map((r) => ({ ...(r as object), course: undefined }));
      expect(strip(after.all[t]!)).toEqual(strip(before.all[t]!));
    }
    expect(after.all.course_trust_choices).toEqual(before.all.course_trust_choices);
    expect(await installed(db)).toEqual([{ id: current, course: "aion", trusted: true }, expect.objectContaining({ course: "bells" })]);
  }, SLOW);

  test("renames a course that is installed but has no progress yet", async () => {
    const db = new PGlite();
    await migrate(db);
    await as(db, "school_app", () => install(db, "course", 0));
    expect((await renameCourse(db, "course", "aion")).rows).toEqual({ encounters: 0, views: 0, decision_notes: 0, course_installs: 1, course_removals: 0, conversations: 0 });
    expect((await installed(db)).map((c) => c.course)).toEqual(["aion"]);
  }, SLOW);

  test("refuses to rename onto a name with install rows, changing nothing", async () => {
    const db = new PGlite();
    await migrate(db);
    await as(db, "school_app", async () => { await install(db, "course", 0); await install(db, "bells", 1); });
    const before = await snapshot(db);
    expect(await error(renameCourse(db, "course", "bells"))).toBe('the record already has course "bells"; renaming "course" to it would merge two courses');
    expect(await snapshot(db)).toEqual(before);
  }, SLOW);

  test("afterwards the install tables are append-only again", async () => {
    const { db } = await withInstalls();
    await renameCourse(db, "course", "aion");
    await as(db, "school_owner", async () => {
      for (const t of INSTALL_TABLES) expect(await error(db.exec(`UPDATE school.${t} SET course = 'x'`))).toBe(`${t} are append-only`);
    });
  }, SLOW);

  test("leaves school_app unable to log in until the next migrate run, and a refusal leaves its login as it was", async () => {
    const db = await populated();
    await db.exec("ALTER ROLE school_app LOGIN");
    await error(renameCourse(db, "course", "bells"));
    expect(await canLogin(db)).toBe(true);
    await renameCourse(db, "course", "aion");
    expect(await canLogin(db)).toBe(false);
  }, SLOW);

  test("accepts every name config accepts, such as a trailing or doubled hyphen", async () => {
    const db = await populated();
    expect((await renameCourse(db, "course", "aion--2-")).to).toBe("aion--2-");
  }, SLOW);

  test("the learner's progress reads under the new name, and none is left under the old", async () => {
    const db = await populated();
    await renameCourse(db, "course", "aion");
    await as(db, "school_app", async () => {
      const progress = async (c: string) => (await db.query<{ p: unknown }>("SELECT school.lesson_progress($1) AS p", [c])).rows[0]!.p;
      const due = async (c: string) => (await db.query("SELECT * FROM school.due_review($1, '[\"q1\"]'::jsonb, $2, 1, 10)", [c, at(10 * 24 * 3600 * 1000)])).rows.length;
      expect(await due("aion")).toBe(1);
      expect(await due("course")).toBe(0);
      expect(await progress("course")).toEqual(await progress("no-such-course"));
    });
  }, SLOW);

  test("afterwards the record is append-only again", async () => {
    const db = await populated();
    await renameCourse(db, "course", "aion");
    await as(db, "school_owner", async () => {
      for (const t of TABLES) expect(await error(db.exec(`UPDATE school.${t} SET course = 'x'`))).toBe(`${t} are append-only`);
    });
  }, SLOW);

  test("refuses a bad name, a course with no record, and a name that already has one, changing nothing", async () => {
    const db = await populated();
    const before = await snapshot(db);
    expect(await error(renameCourse(db, "course", "Not A Name"))).toBe('"Not A Name" is not a course name: a lowercase letter or digit, then lowercase letters, digits and hyphens');
    expect(await error(renameCourse(db, "course", "api"))).toBe('"api" is reserved and cannot name a course');
    expect(await error(renameCourse(db, "course", "course"))).toBe("the course would be renamed to itself");
    expect(await error(renameCourse(db, "nothing", "aion"))).toBe('the record has nothing for course "nothing"');
    expect(await error(renameCourse(db, "course", "bells"))).toBe('the record already has course "bells"; renaming "course" to it would merge two courses');
    expect(await snapshot(db)).toEqual(before);
    expect((await db.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u).toBe("postgres");
  }, SLOW);
});
