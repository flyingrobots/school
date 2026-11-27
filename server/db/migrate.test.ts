// The numbered-migration runner (flyingrobots/school#45): idempotent, one transaction per file,
// a ledger of applied versions with their checksums.
import { afterAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, readMigrations } from "./migrate.ts";

const SLOW = 30_000;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function folder(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "school-migrations-"));
  dirs.push(d);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql);
  return d;
}

// Every file runs as school_owner, which may create objects only in schema school.
const tables = async (db: PGlite) =>
  (await db.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'school' ORDER BY 1")).rows.map((r) => r.t);
const ledger = async (db: PGlite) =>
  (await db.query<{ version: number; name: string }>("SELECT version, name FROM schema_migrations ORDER BY version")).rows;

test("the shipped migrations are numbered from 0001 without gaps", () => {
  const ms = readMigrations(MIGRATIONS);
  expect(ms.map((m) => m.version)).toEqual(ms.map((_, i) => i + 1));
  expect(ms[0]!.name).toBe("0001_init.sql");
});

test("files apply in order, each recorded once; a second run applies nothing", async () => {
  const d = folder({ "0002_b.sql": "CREATE TABLE school.b (id int REFERENCES school.a (id));", "0001_a.sql": "CREATE TABLE school.a (id int PRIMARY KEY);" });
  const db = new PGlite();
  expect(await migrate(db, d)).toEqual({ applied: [1, 2] });
  expect(await migrate(db, d)).toEqual({ applied: [] });
  expect(await tables(db)).toEqual(["a", "b"]);
  expect(await ledger(db)).toEqual([{ version: 1, name: "0001_a.sql" }, { version: 2, name: "0002_b.sql" }]);
}, SLOW);

test("a school_owner that already exists with every attribute the runner forbids has none of them once a file is applied", async () => {
  const db = new PGlite();
  await db.exec("CREATE ROLE school_owner SUPERUSER LOGIN CREATEROLE CREATEDB REPLICATION BYPASSRLS");
  await migrate(db, folder({ "0001_a.sql": "CREATE TABLE school.a (id int);" }));
  const { rows } = await db.query(`SELECT rolsuper, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    FROM pg_roles WHERE rolname = 'school_owner'`);
  expect(rows).toEqual([{ rolsuper: false, rolcanlogin: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false }]);
}, SLOW);

test("a failing file leaves nothing of itself behind and is not recorded; earlier files stay applied", async () => {
  const d = folder({ "0001_a.sql": "CREATE TABLE school.a (id int);", "0002_bad.sql": "CREATE TABLE school.half (id int); SELECT no_such_function();" });
  const db = new PGlite();
  await expect(migrate(db, d)).rejects.toThrow(/0002_bad\.sql.*no_such_function/);
  expect(await tables(db)).toEqual(["a"]);
  expect(await ledger(db)).toEqual([{ version: 1, name: "0001_a.sql" }]);
}, SLOW);

test("an applied file whose contents changed is refused, and nothing runs", async () => {
  const d = folder({ "0001_a.sql": "CREATE TABLE school.a (id int);" });
  const db = new PGlite();
  await migrate(db, d);
  writeFileSync(join(d, "0001_a.sql"), "CREATE TABLE school.a (id bigint);");
  writeFileSync(join(d, "0002_b.sql"), "CREATE TABLE school.b (id int);");
  await expect(migrate(db, d)).rejects.toThrow(/0001_a\.sql has changed since it was applied/);
  expect(await tables(db)).toEqual(["a"]);
}, SLOW);

test("misnamed or duplicated version numbers are refused before anything runs", () => {
  expect(() => readMigrations(folder({ "1_a.sql": "" }))).toThrow(/1_a\.sql is not named NNNN_name\.sql/);
  expect(() => readMigrations(folder({ "0001_a.sql": "", "0001_b.sql": "" }))).toThrow(/version 1 is used twice/);
  expect(() => readMigrations(folder({ "0001_a.sql": "", "0003_c.sql": "" }))).toThrow(/version 2 is missing/);
});

/** The shipped migrations, copied, plus `extra` files: a later migration as its author would write it. */
/** The shipped versions, and the file name prefix of the next one, so these tests outlive each new migration. */
const SHIPPED = readMigrations(MIGRATIONS).map((m) => m.version);
const NEXT = String(SHIPPED.length + 1).padStart(4, "0");

function shippedPlus(extra: Record<string, string>): string {
  const d = folder(extra);
  for (const f of readdirSync(MIGRATIONS)) copyFileSync(join(MIGRATIONS, f), join(d, f));
  return d;
}

test("a later migration that never switches role still creates objects owned by school_owner, revoked from PUBLIC", async () => {
  const d = shippedPlus({ [`${NEXT}_later.sql`]: `
    CREATE FUNCTION school.forgot_role() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = school, pg_temp AS 'SELECT 1';
    CREATE TABLE school.later (id int);` });
  const db = new PGlite();
  expect(await migrate(db, d)).toEqual({ applied: [...SHIPPED, SHIPPED.length + 1] });
  await db.exec("CREATE ROLE stranger NOLOGIN");
  const f = (await db.query<{ owner: string; app: boolean; stranger: boolean; acl: string | null }>(`
    SELECT pg_get_userbyid(proowner) AS owner, proacl::text AS acl,
           has_function_privilege('school_app', oid, 'EXECUTE') AS app, has_function_privilege('stranger', oid, 'EXECUTE') AS stranger
    FROM pg_proc WHERE proname = 'forgot_role'`)).rows[0]!;
  expect(f).toEqual({ owner: "school_owner", acl: "{school_owner=X/school_owner}", app: false, stranger: false });
  const t = (await db.query<{ owner: string }>("SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'later'")).rows[0]!;
  expect(t.owner).toBe("school_owner");
}, SLOW);

test("a later migration cannot create objects outside schema school", async () => {
  const d = shippedPlus({ [`${NEXT}_elsewhere.sql`]: "CREATE FUNCTION public.elsewhere() RETURNS int LANGUAGE sql AS 'SELECT 1';" });
  const db = new PGlite();
  await expect(migrate(db, d)).rejects.toThrow(new RegExp(`${NEXT}_elsewhere\\.sql: permission denied for schema public`));
  expect((await db.query("SELECT 1 FROM pg_proc WHERE proname = 'elsewhere'")).rows).toEqual([]);
}, SLOW);

test("a recorded version whose file is missing is refused, and nothing runs", async () => {
  const d = folder({ "0001_a.sql": "CREATE TABLE school.a (id int);", "0002_b.sql": "CREATE TABLE school.b (id int);" });
  const db = new PGlite();
  await migrate(db, d);
  rmSync(join(d, "0002_b.sql"));
  await expect(migrate(db, d)).rejects.toThrow(/version 2 \(0002_b\.sql\) is recorded as applied but has no file/);
}, SLOW);

test("checksums are compared again after waiting on the lock, so a different file applied meanwhile is refused", async () => {
  const d = folder({ "0001_a.sql": "CREATE TABLE school.a (id int);" });
  const db = new PGlite();
  // Another runner applies a different 0001 while this one waits on the lock.
  const racing = {
    exec: async (sql: string) => {
      const r = await db.exec(sql);
      if (sql.includes("pg_advisory_xact_lock")) {
        await db.query("INSERT INTO public.schema_migrations (version, name, checksum) VALUES (1, '0001_a.sql', 'someone else')");
      }
      return r;
    },
    query: <T>(sql: string, params?: unknown[]) => db.query<T>(sql, params),
  };
  await expect(migrate(racing, d)).rejects.toThrow(/0001_a\.sql has changed since it was applied/);
  expect(await tables(db)).toEqual([]);
}, SLOW);

test("a file that ends or opens a transaction of its own is refused before anything runs", () => {
  for (const sql of ["CREATE TABLE school.a (id int);\nCOMMIT;", "rollback;", "BEGIN;\nCREATE TABLE school.a (id int);", "SELECT 1; end;",
                     "SELECT 1; ABORT", "START TRANSACTION;", "SELECT 1;\n  Commit work;"]) {
    expect(() => readMigrations(folder({ "0001_a.sql": sql }))).toThrow(/0001_a\.sql: the runner owns the transaction; remove its (BEGIN|COMMIT|ROLLBACK|END|ABORT|START)/i);
  }
  // Transaction words inside bodies, strings, identifiers and comments are fine.
  const fine = `-- COMMIT here is a comment
    /* ROLLBACK; in a block comment */
    DO $$ BEGIN PERFORM 1; END $$;
    CREATE FUNCTION school.f() RETURNS int LANGUAGE plpgsql AS $body$ BEGIN RETURN 1; END; $body$;
    CREATE FUNCTION school.g() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;
    SELECT 'commit; rollback;' AS "end";`;
  expect(readMigrations(folder({ "0001_a.sql": fine })).map((m) => m.name)).toEqual(["0001_a.sql"]);
  // Only a routine body opens BEGIN ATOMIC: the words elsewhere must not hide the COMMIT that follows.
  expect(() => readMigrations(folder({ "0001_a.sql": "SELECT begin atomic FROM school.kept;\nCOMMIT;" })))
    .toThrow(/0001_a\.sql: the runner owns the transaction; remove its COMMIT/);
  const routines = `CREATE OR REPLACE PROCEDURE school.p() LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;
    create function school.h(x int) returns int language sql begin atomic select x; end;`;
  expect(readMigrations(folder({ "0001_a.sql": routines })).map((m) => m.name)).toEqual(["0001_a.sql"]);
});

test("a file that changes role is refused before anything runs, and one that escapes the owner at run time rolls back", async () => {
  for (const sql of ["RESET ROLE;", "SET ROLE postgres;", "set local role school_app;", "SET SESSION AUTHORIZATION postgres;",
                     "CREATE TABLE school.a (id int);\nreset session authorization;"]) {
    expect(() => readMigrations(folder({ "0001_a.sql": sql }))).toThrow(/0001_a\.sql: the runner runs every file as school_owner; remove its (SET|RESET)/);
  }
  const d = folder({ "0001_a.sql": "DO $$ BEGIN EXECUTE 'RESET ROLE'; END $$;\nCREATE TABLE public.escaped (id int);" });
  const db = new PGlite();
  await expect(migrate(db, d)).rejects.toThrow(/0001_a\.sql: must end as school_owner, not postgres/);
  expect((await db.query("SELECT 1 FROM pg_tables WHERE tablename = 'escaped'")).rows).toEqual([]);
  expect((await db.query("SELECT 1 FROM public.schema_migrations")).rows).toEqual([]);
}, SLOW);

// PGlite is one connection, so two runners cannot really race here. What can be checked is the
// order: the migration lock is taken before the ledger is created or read, and released at the end,
// on success and on failure alike. The race itself belongs to the real-Postgres job (flyingrobots/school#50).
test("the migration lock is taken before the ledger is touched, and released after, even on failure", async () => {
  for (const [files, fails] of [[{ "0001_a.sql": "CREATE TABLE school.a (id int);" }, false],
                                [{ "0001_a.sql": "SELECT no_such_function();" }, true]] as const) {
    const db = new PGlite();
    const seen: string[] = [];
    const recording = {
      exec: (sql: string) => { seen.push(sql); return db.exec(sql); },
      query: <T>(sql: string, params?: unknown[]) => { seen.push(sql); return db.query<T>(sql, params); },
    };
    const run = migrate(recording, folder(files));
    if (fails) await expect(run).rejects.toThrow(/no_such_function/); else await run;
    const lock = seen.findIndex((s) => /pg_advisory_lock\(/.test(s));
    const ledger = seen.findIndex((s) => s.includes("schema_migrations") && !s.includes("pg_advisory")); // the lock key names it too
    expect(lock).toBe(0);
    expect(ledger).toBeGreaterThan(lock);
    expect(seen.at(-1)).toMatch(/pg_advisory_unlock\(/);
    const held = (await db.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory'")).rows;
    expect(held).toEqual([]);
  }
}, SLOW);

// flyingrobots/school#120: the migrate job prints a line for each file as it commits.
test("onApplied hears of each file once its transaction commits, in order; not of a failing file; nothing on a second run", async () => {
  const d = folder({ "0001_a.sql": "CREATE TABLE school.a (id int);", "0002_b.sql": "CREATE TABLE school.b (id int);" });
  const db = new PGlite();
  const heard: string[] = [];
  expect(await migrate(db, d, (m) => heard.push(`${m.version} ${m.name}`))).toEqual({ applied: [1, 2] });
  expect(heard).toEqual(["1 0001_a.sql", "2 0002_b.sql"]);
  expect(await migrate(db, d, (m) => heard.push(`${m.version} ${m.name}`))).toEqual({ applied: [] });
  expect(heard).toHaveLength(2);

  const bad = folder({ "0001_a.sql": "CREATE TABLE school.a (id int);", "0002_bad.sql": "SELECT no_such_function();" });
  const failing: string[] = [];
  await expect(migrate(new PGlite(), bad, (m) => failing.push(m.name))).rejects.toThrow(/0002_bad\.sql/);
  expect(failing).toEqual(["0001_a.sql"]);

  // Told after COMMIT: a listener that throws stops the run, but the file it heard of stays applied.
  const after = new PGlite();
  await expect(migrate(after, d, () => { throw new Error("listener failed"); })).rejects.toThrow(/listener failed/);
  expect(await ledger(after)).toEqual([{ version: 1, name: "0001_a.sql" }]);
  expect(await tables(after)).toEqual(["a"]);
}, SLOW);
