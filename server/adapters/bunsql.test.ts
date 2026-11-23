// The Bun.SQL driver against a real Postgres server (flyingrobots/school#47): the LearningRecord
// contract, the migration on one reserved connection, and requests as school_app on a pool.
//
// It needs SCHOOL_TEST_POSTGRES_URL, a superuser URL to a scratch server (CI starts one; locally,
// `docker run -e POSTGRES_PASSWORD=pw -p 127.0.0.1:5432:5432 postgres:18.7` and
// postgres://postgres:pw@127.0.0.1:5432/postgres). Each test gets its own database, copied from
// one migrated template, and every database it makes is dropped at the end.
import { afterAll, describe, expect, test } from "bun:test";
import { learningRecordContract } from "../contract/learning-record.ts";
import { APP, FUNCTION_CALL, openDatabase, redact, type Opened } from "./database.ts";
import { bunSql } from "./bunsql.ts";
import { postgresRecord } from "./postgres.ts";

const URL_ = process.env.SCHOOL_TEST_POSTGRES_URL;
const SLOW = 30_000;

const run = `school_test_${process.pid}_${Date.now()}`;
const made: string[] = [];
const opened: { close(): Promise<void> }[] = [];
const withDb = (url: string, db: string) => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

let admin: InstanceType<typeof Bun.SQL> | undefined;
let template: Promise<string> | undefined;

/** A new, empty database on the test server; dropped in afterAll. */
async function database(from?: string): Promise<string> {
  admin ??= new Bun.SQL(URL_!);
  const name = `${run}_${made.length}`;
  made.push(name);
  await admin.unsafe(`CREATE DATABASE ${name}${from === undefined ? "" : ` TEMPLATE ${from}`}`);
  return withDb(URL_!, name);
}

/** A migrated database of its own, opened as the server opens one; `url` is its superuser URL. */
async function fresh(): Promise<Opened & { url: string }> {
  template ??= (async () => {
    const url = await database();
    await (await openDatabase({ driver: "postgres", url })).close(); // a template may have no connections
    return made[made.length - 1]!;
  })();
  // Tests in a file run one at a time, so the previous test's pool is done with: close it, or the
  // pools would exhaust the server's connections.
  for (const o of opened.splice(0)) await o.close();
  const url = await database(await template);
  const o = await openDatabase({ driver: "postgres", url });
  opened.push(o);
  return { ...o, url };
}

afterAll(async () => {
  // Bun.SQL pools close lazily; dropping a database waits for none of them (WITH (FORCE)).
  for (const o of opened.splice(0)) await o.close();
  if (admin !== undefined) {
    for (const name of made.reverse()) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.close();
  }
}, SLOW);

describe.skipIf(URL_ === undefined || URL_ === "")("Bun.SQL on a real Postgres (SCHOOL_TEST_POSTGRES_URL)", () => {
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
    const pool = new Bun.SQL(url);
    opened.push(pool);
    const sql = bunSql(pool, APP);
    const who = await Promise.all(Array.from({ length: 40 }, () => sql.query<{ u: string }>("SELECT current_user AS u", [])));
    expect(new Set(who.map((r) => r[0]!.u))).toEqual(new Set([APP]));
    // The same pool, used directly: SET LOCAL ended with each transaction, on every connection.
    const raw = await Promise.all(Array.from({ length: 20 }, () => pool.unsafe("SELECT current_user AS u")));
    expect(raw.every((r) => r[0].u !== APP)).toBe(true);
  }, SLOW);

  test("school_app may not touch a table, and the server's record refuses any statement but a function call", async () => {
    const { url, sql: record } = await fresh();
    const pool = new Bun.SQL(url);
    opened.push(pool);
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
    const pool = new Bun.SQL(url);
    opened.push(pool);
    const sql = bunSql(pool, APP);
    await expect(sql.query("SELECT 1/0", [])).rejects.toThrow(/division by zero/);
    expect((await sql.query<{ u: string }>("SELECT current_user AS u", []))[0]!.u).toBe(APP);
  }, SLOW);

  test("a role name is never interpolated unless it is a plain identifier", () => {
    expect(() => bunSql(new Bun.SQL(URL_!), "school_app; DROP SCHEMA school")).toThrow(/plain role name/);
  });
});

test("the log names a postgres URL without its password", () => {
  expect(redact("postgres://school:s3cret@db:5432/school")).toBe("postgres://school:***@db:5432/school");
  expect(redact("postgres://db/school")).toBe("postgres://db/school");
  expect(redact("postgres://school:s3cret@db:5432/school")).not.toContain("s3cret");
});

// Skipping is for a laptop without Postgres; on CI a missing URL would silently drop this file.
test.if(process.env.CI === "true")("CI provides SCHOOL_TEST_POSTGRES_URL, so the Bun.SQL tests above ran", () => {
  expect(URL_ ?? "").toStartWith("postgres://");
});
