// Opening the record on PGlite as the server does (flyingrobots/school#47): migrated as the owner on
// first start, served as school_app through a Sql that runs function calls only.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { postgresRecord } from "./postgres.ts";
import { ownerQuery } from "../testing/record.ts";
import { readMigrations } from "../db/migrate.ts";

const SLOW = 30_000; // PGlite starts a whole Postgres in process.
const root = mkdtempSync(join(tmpdir(), "school-database-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("pglite: migrates on first open, applies nothing on the next, and keeps what was recorded", async () => {
  const dir = join(root, "a", "record"); // parents are created
  const first = await openDatabase({ driver: "pglite", dir });
  // Every shipped migration, in order, and none twice: 1, 2, ... as server/db/migrations holds them.
  expect(first.applied).toEqual(readMigrations().map((m) => m.version));
  expect(first.applied[0]).toBe(1);
  await postgresRecord(first.sql).recordView({ course: "c", lesson: "l1" }, "2026-11-22T10:00:00.000Z");
  await first.close();
  const second = await openDatabase({ driver: "pglite", dir });
  expect(second.applied).toEqual([]);
  await second.close();
  expect(await ownerQuery(dir, "SELECT course, lesson FROM school.views")).toEqual([{ course: "c", lesson: "l1" }]);
}, SLOW);

test("pglite: a record already open is refused, naming its folder, until the first closes it", async () => {
  const dir = join(root, "locked");
  const first = await openDatabase({ driver: "pglite", dir });
  try {
    await expect(openDatabase({ driver: "pglite", dir })).rejects.toThrow(new RegExp(`${dir}.*in use`));
    await expect(ownerQuery(dir, "SELECT 1")).rejects.toThrow(/in use/); // the test helper takes the same lock
  } finally {
    await first.close();
  }
  const again = await openDatabase({ driver: "pglite", dir });
  await again.close();
}, SLOW);

test("pglite: the server's record refuses any statement but a function call, so it cannot take the superuser back", async () => {
  const o = await openDatabase({ driver: "pglite", dir: join(root, "b") });
  try {
    for (const text of ["RESET ROLE", "RESET ROLE; SELECT 1", "SELECT * FROM school.views", "INSERT INTO school.views (course, lesson, at) VALUES ($1, $2, now())"]) {
      await expect(o.sql.query(text, ["c", "l"])).rejects.toThrow(/only function calls/);
    }
    // And the calls it does run, run as school_app: lesson_progress is granted, a table is not.
    expect(await o.sql.query("SELECT * FROM school.lesson_progress($1)", ["c"])).toEqual([{ lesson_progress: {} }]);
  } finally {
    await o.close();
  }
}, SLOW);
