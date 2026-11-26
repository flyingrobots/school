// The install record's storage rules (RFC 7 §7; flyingrobots/school#232), on PGlite. What the
// functions answer is the LearningRecord contract's (server/contract/learning-record.ts); this file
// holds what the contract cannot see: which names the table admits, and that its source can widen.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { NAME, RESERVED } from "../config.ts";
import { CourseName } from "../core/model.ts";
import { migrate } from "./migrate.ts";
import { badCourseName } from "./rename-course.ts";

const SLOW = 30_000; // PGlite starts a whole Postgres in process.
const at = "2001-02-03T04:05:06.789Z";

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}

const install = (db: PGlite, course: string) =>
  db.query("SELECT school.install_course($1, $2, 'git', 'https://example.com/c.git', NULL, $3, $4, 'C', NULL, $5)",
    [crypto.randomUUID(), course, "a".repeat(40), "c".repeat(64), at]);

describe("course installs", () => {
  // Oracle: config.ts's NAME and RESERVED, the rule a configured course's name already obeys.
  test("the record, the model and config admit exactly the same course names", async () => {
    const db = new PGlite();
    await migrate(db);
    const names = [
      ...RESERVED, "a", "0", "bells", "school-bells", "aion--2-", "c-3", "-bells", "Bells", "bells.git", "bells_1", "bé", " bells", "bells ", "",
      "a".repeat(300), "api2", "my-api",
    ];
    const verdicts = await as(db, "school_app", async () => {
      const out: string[] = [];
      for (const n of names) {
        const stored = await install(db, n).then(() => true, () => false);
        out.push(`${JSON.stringify(n)}: record ${stored}, model ${CourseName.safeParse(n).success}, config ${badCourseName(n) === null}`);
      }
      return out;
    });
    const expected = names.map((n) => {
      const ok = NAME.test(n) && !(RESERVED as readonly string[]).includes(n);
      return `${JSON.stringify(n)}: record ${ok}, model ${ok}, config ${ok}`;
    });
    expect(verdicts).toEqual(expected);
    expect(expected.filter((v) => v.endsWith("true")).length).toBeGreaterThan(4); // witnesses on both sides
    expect(expected.filter((v) => v.endsWith("false")).length).toBeGreaterThan(4);
  }, SLOW);

  // RFC 9 will add an `authored` source in a migration of its own: the source rule is one named
  // CHECK, and the URL and bundle rules ask only that each is set for its own source.
  test("a later migration can widen the sources by replacing one named CHECK", async () => {
    const db = new PGlite();
    await migrate(db);
    const authored = () => db.query("SELECT school.install_course($1, 'notes', 'authored', NULL, NULL, $2, $3, 'Notes', NULL, $4) AS s",
      [crypto.randomUUID(), "a".repeat(40), "c".repeat(64), at]);
    expect(await as(db, "school_app", () => authored().then(() => "stored", (e: Error) => e.message)))
      .toContain('violates check constraint "course_installs_source"');
    await as(db, "school_owner", () => db.exec(`ALTER TABLE school.course_installs DROP CONSTRAINT course_installs_source,
      ADD CONSTRAINT course_installs_source CHECK (source IN ('git', 'bundle', 'authored'))`));
    expect((await as(db, "school_app", authored)).rows).toEqual([{ s: "installed" }]);
  }, SLOW);
});
