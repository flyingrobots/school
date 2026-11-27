// The install record's storage rules (RFC 7 §7; flyingrobots/school#232), on PGlite. What the
// functions answer is the LearningRecord contract's (server/contract/learning-record.ts); this file
// holds what the contract cannot see: which names and titles the table admits. The `authored` source
// (RFC 9 §5.5) and its columns are in server/db/authoring.test.ts.
import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { NAME, RESERVED } from "../config.ts";
import { CourseInstall, CourseName } from "../core/model.ts";
import { migrate } from "./migrate.ts";
import { badCourseName } from "./rename-course.ts";

const SLOW = 30_000; // PGlite starts a whole Postgres in process.
const at = "2001-02-03T04:05:06.789Z";

async function as<T>(db: PGlite, role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE ${role}`);
  try { return await fn(); } finally { await db.exec("RESET ROLE"); }
}

const install = (db: PGlite, course: string) =>
  db.query("SELECT school.install_course($1, $2, 'git', 'https://example.com/c.git', NULL, $3, $4, 'C', NULL, NULL, NULL, $5)",
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

  // Oracle: the model's title, trimmed and non-empty. A row the table kept that the model refuses
  // would break every later read of the installed courses.
  test("the table admits exactly the titles the model reads back unchanged", async () => {
    const db = new PGlite();
    await migrate(db);
    const titles = ["", " ", "\t", "\n", "\u00a0", "\u3000", "\ufeff", "\u2028", "a ", " a", "\ta", "a\n", "\u00a0a", "a\u3000", "\ufeffa",
      "a b", "a\u00a0b", "Bells", "é", "\u200b", "a\u200b"];
    const stored = (title: string) => as(db, "school_app", () => db.query(
      "SELECT school.install_course($1, 'bells', 'git', 'https://example.com/c.git', NULL, $2, $3, $4, NULL, NULL, NULL, $5)",
      [crypto.randomUUID(), "a".repeat(40), "c".repeat(64), title, at]).then(() => true, () => false));
    const model = (title: string) => {
      const p = CourseInstall.safeParse({ id: crypto.randomUUID(), course: "bells", source: "git", url: "https://example.com/c.git", bundleSha256: null,
        commit: "a".repeat(40), contentSha256: "c".repeat(64), title, format: null });
      return p.success && p.data.title === title;
    };
    const verdicts: string[] = [];
    for (const t of titles) verdicts.push(`${JSON.stringify(t)}: table ${await stored(t)}`);
    expect(verdicts).toEqual(titles.map((t) => `${JSON.stringify(t)}: table ${model(t)}`));
    expect(titles.filter(model).length).toBeGreaterThan(3); // witnesses on both sides
    expect(titles.filter((t) => !model(t)).length).toBeGreaterThan(8);
  }, SLOW);
});
