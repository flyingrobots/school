// The Bun.SQL driver against a real Postgres server (flyingrobots/school#47): the LearningRecord
// contract, the migration on one reserved connection, and requests as school_app on a pool.
//
// It needs SCHOOL_TEST_POSTGRES_URL, a superuser URL to a scratch server (CI starts one; locally,
// `docker run -e POSTGRES_PASSWORD=pw -p 127.0.0.1:5432:5432 postgres:18.7` and
// postgres://postgres:pw@127.0.0.1:5432/postgres). Each test gets its own database, copied from
// one migrated template, and every database it makes is dropped at the end
// (server/testing/postgres.ts).
import { describe, expect, test } from "bun:test";
import { learningRecordContract } from "../contract/learning-record.ts";
import { scratchPostgres, TEST_POSTGRES_URL as URL_ } from "../testing/postgres.ts";
import { APP, FUNCTION_CALL, openDatabase, redact } from "./database.ts";
import { bunSql } from "./bunsql.ts";
import { postgresRecord } from "./postgres.ts";

const SLOW = 30_000;

// Every database made here is dropped when the file ends (server/testing/postgres.ts).
const { database, fresh, track } = scratchPostgres();

describe.skipIf(URL_ === undefined)("Bun.SQL on a real Postgres (SCHOOL_TEST_POSTGRES_URL)", () => {
  learningRecordContract("postgres (Bun.SQL)", async () => postgresRecord((await fresh()).sql), { recordsExposures: true });

  test("opening migrates on first start and applies nothing on the next", async () => {
    const url = await database();
    const first = await openDatabase({ driver: "postgres", url });
    expect(first.applied).toEqual([1, 2]);
    await first.close();
    const second = await openDatabase({ driver: "postgres", url });
    expect(second.applied).toEqual([]);
    await second.close();
  }, SLOW);

  test("two servers starting at once on one database migrate it once", async () => {
    const url = await database();
    const both = await Promise.all([openDatabase({ driver: "postgres", url }), openDatabase({ driver: "postgres", url })]);
    expect(both.map((o) => o.applied).sort()).toEqual([[], [1, 2]]);
    for (const o of both) await o.close();
  }, SLOW);

  test("every request runs as school_app, and no pooled connection keeps the role afterwards", async () => {
    const { url } = await fresh();
    const pool = track(new Bun.SQL(url));
    const sql = bunSql(pool, APP);
    const who = await Promise.all(Array.from({ length: 40 }, () => sql.query<{ u: string }>("SELECT current_user AS u", [])));
    expect(new Set(who.map((r) => r[0]!.u))).toEqual(new Set([APP]));
    // The same pool, used directly: SET LOCAL ended with each transaction, on every connection.
    const raw = await Promise.all(Array.from({ length: 20 }, () => pool.unsafe("SELECT current_user AS u")));
    expect(raw.every((r) => r[0].u !== APP)).toBe(true);
  }, SLOW);

  test("school_app may not touch a table, and the server's record refuses any statement but a function call", async () => {
    const { url, sql: record } = await fresh();
    const pool = track(new Bun.SQL(url));
    const sql = bunSql(pool, APP);
    await expect(sql.query("INSERT INTO school.views (course, lesson, at) VALUES ($1, $2, now())", ["c", "l"])).rejects.toThrow(/permission denied/);
    await expect(sql.query("SELECT * FROM school.answers", [])).rejects.toThrow(/permission denied/);
    // The driver alone would run a script that takes the login's role back; the record never hands it one.
    expect((await sql.query<{ u: string }>("RESET ROLE; SELECT current_user AS u", []))[0]?.u).not.toBe(APP);
    for (const text of ["RESET ROLE; SELECT current_user AS u", "SELECT * FROM school.answers", "SELECT * FROM school.record_view($1, $2, $3); RESET ROLE"]) {
      expect(FUNCTION_CALL.test(text)).toBe(false);
      await expect(record.query(text, [])).rejects.toThrow(/only function calls/);
    }
    expect(FUNCTION_CALL.test("SELECT * FROM school.record_view($1, $2, $3)")).toBe(true);
  }, SLOW);

  test("a statement that fails rolls back its own transaction and leaves the pool usable", async () => {
    const { url } = await fresh();
    const pool = track(new Bun.SQL(url));
    const sql = bunSql(pool, APP);
    await expect(sql.query("SELECT 1/0", [])).rejects.toThrow(/division by zero/);
    expect((await sql.query<{ u: string }>("SELECT current_user AS u", []))[0]!.u).toBe(APP);
  }, SLOW);

  test("a role name is never interpolated unless it is a plain identifier", () => {
    expect(() => bunSql(new Bun.SQL(URL_!), "school_app; DROP SCHEMA school")).toThrow(/plain role name/);
  });
});

test("the log names a postgres URL by scheme, host, port and database only: never its user, password or query", () => {
  expect(redact("postgres://school:s3cret@db:5432/school")).toBe("postgres://db:5432/school");
  expect(redact("postgres://db/school")).toBe("postgres://db/school");
  expect(redact("postgresql://db:5432/school?user=school&password=s3cret&sslmode=require")).toBe("postgresql://db:5432/school");
  expect(redact("postgres://school@db/school#frag")).toBe("postgres://db/school");
  expect(redact("postgres://u:p@[bad")).not.toContain("p@");
});

// Skipping is for a laptop without Postgres; on CI a missing URL would silently drop this file.
test.if(process.env.CI === "true")("CI provides SCHOOL_TEST_POSTGRES_URL, so the Bun.SQL tests above ran", () => {
  expect(URL_ ?? "").toStartWith("postgres://");
});
