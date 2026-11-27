// The server logs into Postgres as school_app, and only the migrate job holds the owner's or the
// superuser's URL (flyingrobots/school#91; RFC 3 v0.4.0 §3.1). On the real Postgres server the
// Bun.SQL tests use (SCHOOL_TEST_POSTGRES_URL, a superuser URL); skipped without it, and CI fails a
// run that skips it (server/testing/postgres-gate.ts).
//
// Roles are cluster-wide, so a test that gives school_owner LOGIN, or makes a role of its own,
// undoes it in `finally`.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotStarted, startSchool, timeout } from "../testing/processes.ts";
import { appUrl, scratchPostgres, TEST_APP_PASSWORD, TEST_POSTGRES_URL as URL_ } from "../testing/postgres.ts";
import { APP, GRANTED_FUNCTIONS, migrateRecord, openDatabase, Refused, RESTRICTED_FUNCTIONS, RESTRICTED_RELATIONS } from "./database.ts";
import { postgresRecord } from "./postgres.ts";
import { OWNER, readMigrations } from "../db/migrate.ts";

const SLOW = 30_000;
const { database, fresh, track } = scratchPostgres();

/** `url` (a superuser URL) logging in as `user` with `password` instead. */
const as = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

/** Whether schema `school` exists in the database at `url`, asked as the superuser. */
async function hasSchool(url: string): Promise<boolean> {
  const db = new Bun.SQL(url);
  try {
    return (await db.unsafe("SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'school'"))[0].n === 1;
  } finally {
    await db.close();
  }
}

/** The SQLSTATE `statement` fails with, run on `db`; "ok" if it succeeds (in a transaction rolled back either way). */
async function outcome(db: InstanceType<typeof Bun.SQL>, statement: string): Promise<string> {
  const ROLLBACK = new Error("rollback");
  try {
    await db.begin(async (tx) => {
      await tx.unsafe(statement);
      throw ROLLBACK;
    });
    return "unreachable";
  } catch (e) {
    if (e === ROLLBACK) return "ok";
    return String((e as { errno?: string }).errno ?? (e as Error).message);
  }
}

const MIGRATE = join(import.meta.dir, "..", "migrate.ts");

/** Run the migrate command (server/migrate.ts) with `env`; its exit code and both streams. */
async function migrateCommand(env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", MIGRATE], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

const lines = (text: string) => text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);

describe.skipIf(URL_ === undefined)("Bun.SQL on a real Postgres, logged in as school_app (SCHOOL_TEST_POSTGRES_URL)", () => {
  test("the migrate job applies every migration as the owner, gives school_app LOGIN with its password, and applies nothing on the next run", async () => {
    const url = await database();
    expect(await migrateRecord(url, TEST_APP_PASSWORD)).toEqual({ applied: readMigrations().map((m) => m.version) });
    expect(await migrateRecord(url, TEST_APP_PASSWORD)).toEqual({ applied: [] });
    const app = track(new Bun.SQL(appUrl(url)));
    expect((await app.unsafe("SELECT current_user AS u, session_user AS s"))[0]).toEqual({ u: APP, s: APP });
    // A wrong password is refused: the password is the one the job set, not trust.
    const wrong = new Bun.SQL(as(url, APP, `${TEST_APP_PASSWORD}x`));
    await expect(wrong.unsafe("SELECT 1")).rejects.toThrow(/password authentication failed/);
    await wrong.close().catch(() => {});
  }, SLOW);

  test("the migrate job refuses a password that is short or would need escaping in a URL, before connecting", async () => {
    const url = await database();
    for (const pw of ["", "short1", "has space in it 0123", "quote'quote'quote'1", "slash/slash/slash/1"]) {
      await expect(migrateRecord(url, pw)).rejects.toThrow(/SCHOOL_APP_PASSWORD/);
    }
    expect(await hasSchool(url)).toBe(false);
  }, SLOW);

  test("the migrate command applies the migrations, exits 0, and prints JSON lines naming neither password", async () => {
    const url = await database();
    const superPassword = new URL(url).password;
    const first = await migrateCommand({ SCHOOL_MIGRATE_URL: url, SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD });
    expect(first.code).toBe(0);
    const out = lines(first.stdout);
    expect(out.at(-1)).toMatchObject({ kind: "school.migrate", event: "done", ok: true, applied: readMigrations().map((m) => m.version), role: APP });
    for (const text of [first.stdout, first.stderr]) {
      expect(text).not.toContain(TEST_APP_PASSWORD);
      if (superPassword !== "") expect(text).not.toContain(superPassword);
    }
    const again = await migrateCommand({ SCHOOL_MIGRATE_URL: url, SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD });
    expect(again.code).toBe(0);
    expect(lines(again.stdout).at(-1)).toMatchObject({ event: "done", ok: true, applied: [] });
  }, SLOW);

  // flyingrobots/school#123: under compose both passwords are files (server/secrets.ts), and the URL names no password.
  test("SEC-M1: the migrate command reads both passwords from *_FILE, preferred over the plain variables, and prints neither", async () => {
    const url = await database();
    const superPassword = decodeURIComponent(new URL(url).password);
    const dir = mkdtempSync(join(tmpdir(), "school-migrate-secrets-"));
    try {
      writeFileSync(join(dir, "postgres_password"), `${superPassword}\n`, { mode: 0o600 });
      writeFileSync(join(dir, "app_password"), `${TEST_APP_PASSWORD}\n`, { mode: 0o600 });
      const bare = new URL(url);
      bare.password = "";
      const r = await migrateCommand({
        SCHOOL_MIGRATE_URL: bare.toString(),
        SCHOOL_MIGRATE_PASSWORD_FILE: join(dir, "postgres_password"),
        SCHOOL_APP_PASSWORD: "aWrongPlainPassword0123456789", // the file wins
        SCHOOL_APP_PASSWORD_FILE: join(dir, "app_password"),
      });
      expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
      expect(lines(r.stdout).at(-1)).toMatchObject({ kind: "school.migrate", event: "done", ok: true });
      for (const text of [r.stdout, r.stderr]) {
        expect(text).not.toContain(TEST_APP_PASSWORD);
        if (superPassword !== "") expect(text).not.toContain(superPassword);
      }
      // The job set school_app's password from the file, not the plain variable.
      const app = track(new Bun.SQL(appUrl(url)));
      expect((await app.unsafe("SELECT current_user AS u"))[0]).toEqual({ u: APP });
      // A password in the URL and in a file is refused, exit 2, before connecting.
      const twice = await migrateCommand({ SCHOOL_MIGRATE_URL: url, SCHOOL_MIGRATE_PASSWORD_FILE: join(dir, "postgres_password"), SCHOOL_APP_PASSWORD_FILE: join(dir, "app_password") });
      expect(twice.code).toBe(2);
      expect(lines(twice.stderr).at(-1)).toMatchObject({ kind: "school.migrate", event: "error", code: 2 });
      // A missing file is refused, exit 2, naming the variable.
      const missing = await migrateCommand({ SCHOOL_MIGRATE_URL: bare.toString(), SCHOOL_MIGRATE_PASSWORD_FILE: join(dir, "nope"), SCHOOL_APP_PASSWORD_FILE: join(dir, "app_password") });
      expect(missing.code).toBe(2);
      expect(String(lines(missing.stderr).at(-1)!.message)).toContain("SCHOOL_MIGRATE_PASSWORD_FILE");
      for (const text of [twice.stdout, twice.stderr, missing.stdout, missing.stderr]) {
        expect(text).not.toContain(TEST_APP_PASSWORD);
        if (superPassword !== "") expect(text).not.toContain(superPassword);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, SLOW);

  test("the migrate command refuses to run without its owner URL or school_app's password, exit 2, as a JSON line", async () => {
    const url = await database();
    for (const env of [{ SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD }, { SCHOOL_MIGRATE_URL: url }, { SCHOOL_MIGRATE_URL: "pglite:/tmp/x", SCHOOL_APP_PASSWORD: TEST_APP_PASSWORD }]) {
      const r = await migrateCommand(env);
      expect(r.code).toBe(2);
      expect(lines(r.stderr).at(-1)).toMatchObject({ kind: "school.migrate", event: "error" });
      expect(r.stderr + r.stdout).not.toContain(TEST_APP_PASSWORD);
    }
    expect(await hasSchool(url)).toBe(false);
  }, SLOW);

  test("school_app's own connection cannot CREATE, ALTER, TRUNCATE, write a table, or COPY TO PROGRAM", async () => {
    const { appUrl: app } = await fresh();
    const db = track(new Bun.SQL(app));
    const denied = [
      "CREATE TABLE school.probe (x int)",
      "CREATE TABLE public.probe (x int)",
      "CREATE TEMP TABLE probe (x int)",
      "CREATE SCHEMA probe",
      "CREATE FUNCTION school.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "ALTER TABLE school.answers ADD COLUMN probe int",
      "ALTER FUNCTION school.lesson_progress(text) SECURITY INVOKER",
      "ALTER TABLE school.answers DISABLE TRIGGER ALL",
      "TRUNCATE school.answers",
      "TRUNCATE school.views",
      "INSERT INTO school.views (course, lesson, at) VALUES ('c', 'l', now())",
      "UPDATE school.answers SET correct = NOT correct",
      "DELETE FROM school.answers",
      "SELECT * FROM school.answers",
      "SELECT * FROM public.schema_migrations",
      "COPY (SELECT 1) TO PROGRAM 'true'",
      "COPY school.views FROM PROGRAM 'true'",
      `SET ROLE ${OWNER}`,
      "SET ROLE postgres",
    ];
    const outcomes = Object.fromEntries(await Promise.all(denied.map(async (s) => [s, await outcome(db, s)] as const)));
    expect(outcomes).toEqual(Object.fromEntries(denied.map((s) => [s, "42501"]))); // insufficient_privilege, every one
    // What it may do: call a granted function.
    expect(await outcome(db, "SELECT * FROM school.lesson_progress('c')")).toBe("ok");
  }, SLOW);

  test("the server opens school_app's URL without migrating, serves as school_app, and runs only function calls", async () => {
    const { url, appUrl: app } = await fresh();
    const o = await openDatabase({ driver: "postgres", url: app });
    try {
      expect(o.applied).toEqual([]);
      expect(o.where).not.toContain(TEST_APP_PASSWORD);
      expect(o.where).toContain(APP);
      await postgresRecord(o.sql).recordView({ course: "c", lesson: "l1" }, "2026-11-22T10:00:00.000Z");
      await expect(o.sql.query("RESET ROLE; SELECT 1", [])).rejects.toThrow(/only function calls/);
    } finally {
      await o.close();
    }
    const su = track(new Bun.SQL(url));
    expect([...await su.unsafe("SELECT course, lesson FROM school.views")]).toEqual([{ course: "c", lesson: "l1" }]);
  }, SLOW);

  test("the server refuses a superuser URL on an empty database, and migrates nothing: only the migrate job does", async () => {
    const url = await database();
    await expect(openDatabase({ driver: "postgres", url })).rejects.toThrow(Refused);
    await expect(openDatabase({ driver: "postgres", url })).rejects.toThrow(/superuser/);
    expect(await hasSchool(url)).toBe(false);
  }, SLOW);

  test("the server refuses school_app's URL on a database the migrate job has not run on", async () => {
    await fresh(); // school_app has LOGIN and the test password on this cluster from here on
    const url = await database();
    await expect(openDatabase({ driver: "postgres", url: appUrl(url) })).rejects.toThrow(/schema school does not exist.*migrate/);
    expect(await hasSchool(url)).toBe(false);
  }, SLOW);

  test("the server refuses a superuser URL on a migrated database", async () => {
    const { url } = await fresh();
    await expect(openDatabase({ driver: "postgres", url })).rejects.toThrow(/superuser/);
  }, SLOW);

  test("the server refuses the owner's login: it owns schema school", async () => {
    const { url } = await fresh();
    const su = track(new Bun.SQL(url));
    await su.unsafe(`ALTER ROLE ${OWNER} LOGIN PASSWORD '${TEST_APP_PASSWORD}'`);
    try {
      const refusal = openDatabase({ driver: "postgres", url: as(url, OWNER, TEST_APP_PASSWORD) });
      await expect(refusal).rejects.toThrow(Refused);
      await expect(openDatabase({ driver: "postgres", url: as(url, OWNER, TEST_APP_PASSWORD) })).rejects.toThrow(/owns schema school/);
    } finally {
      await su.unsafe(`ALTER ROLE ${OWNER} NOLOGIN PASSWORD NULL`);
    }
  }, SLOW);

  test("the server refuses a login that is a member of another role, such as the owner or pg_execute_server_program", async () => {
    const { url } = await fresh();
    const su = track(new Bun.SQL(url));
    const role = `school_test_member_${process.pid}`;
    for (const parent of [OWNER, "pg_execute_server_program"]) {
      await su.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${TEST_APP_PASSWORD}' IN ROLE ${parent}`);
      try {
        await expect(openDatabase({ driver: "postgres", url: as(url, role, TEST_APP_PASSWORD) })).rejects.toThrow(new RegExp(`member of ${parent}`));
      } finally {
        await su.unsafe(`DROP ROLE ${role}`);
      }
    }
    // school_app itself, made a member: refused too.
    await su.unsafe(`GRANT pg_write_server_files TO ${APP}`);
    try {
      await expect(openDatabase({ driver: "postgres", url: appUrl(url) })).rejects.toThrow(/member of pg_write_server_files/);
    } finally {
      await su.unsafe(`REVOKE pg_write_server_files FROM ${APP}`);
    }
  }, SLOW);

  test("the server refuses school_app once it has been granted more than EXECUTE: a table, a schema, a temporary table", async () => {
    const { url, appUrl: app } = await fresh();
    const su = track(new Bun.SQL(url));
    const db = new URL(url).pathname.slice(1);
    const cases: [grant: string, revoke: string, refusal: RegExp][] = [
      [`GRANT INSERT ON school.views TO ${APP}`, `REVOKE INSERT ON school.views FROM ${APP}`, /school\.views/],
      [`GRANT SELECT ON public.schema_migrations TO ${APP}`, `REVOKE SELECT ON public.schema_migrations FROM ${APP}`, /schema_migrations/],
      [`GRANT CREATE ON SCHEMA public TO ${APP}`, `REVOKE CREATE ON SCHEMA public FROM ${APP}`, /create objects in schema public/],
      [`GRANT TEMPORARY ON DATABASE ${db} TO ${APP}`, `REVOKE TEMPORARY ON DATABASE ${db} FROM ${APP}`, /temporary/],
      [`GRANT CREATE ON DATABASE ${db} TO ${APP}`, `REVOKE CREATE ON DATABASE ${db} FROM ${APP}`, /create schemas/],
      [`ALTER ROLE ${APP} CREATEROLE`, `ALTER ROLE ${APP} NOCREATEROLE`, /CREATEROLE/],
    ];
    for (const [grant, revoke, refusal] of cases) {
      await su.unsafe(grant);
      try {
        await expect(openDatabase({ driver: "postgres", url: app })).rejects.toThrow(refusal);
      } finally {
        await su.unsafe(revoke);
      }
    }
    // Every grant undone, it opens again.
    await (await openDatabase({ driver: "postgres", url: app })).close();
  }, SLOW);

  // flyingrobots/school#112 review, F-1: each kind of privilege a hand grant could give school_app
  // beyond the migrations' grants. Each case is undone in `finally`; several are cluster-wide.
  test("the server refuses school_app once it has a column, MAINTAIN, sequence, function, parameter, default-privilege, catalog or database grant", async () => {
    const { url, appUrl: app } = await fresh();
    const su = track(new Bun.SQL(url));
    const owned = `school_test_owned_${process.pid}`;
    const cases: [grant: string, revoke: string, refusal: RegExp][] = [
      [`GRANT SELECT (correct) ON school.answers TO ${APP}`, `REVOKE SELECT (correct) ON school.answers FROM ${APP}`, /column privileges on school\.answers/],
      [`GRANT MAINTAIN ON school.views TO ${APP}`, `REVOKE MAINTAIN ON school.views FROM ${APP}`, /privileges on school\.views/],
      [`GRANT USAGE ON SEQUENCE school.record_seq TO ${APP}`, `REVOKE USAGE ON SEQUENCE school.record_seq FROM ${APP}`, /privileges on school\.record_seq/],
      [`GRANT EXECUTE ON FUNCTION lo_export(oid, text) TO ${APP}`, `REVOKE EXECUTE ON FUNCTION lo_export(oid, text) FROM ${APP}`, /may execute lo_export/],
      ["GRANT EXECUTE ON FUNCTION lo_import(text) TO PUBLIC", "REVOKE EXECUTE ON FUNCTION lo_import(text) FROM PUBLIC", /may execute lo_import/],
      [`GRANT EXECUTE ON FUNCTION pg_read_file(text) TO ${APP}`, `REVOKE EXECUTE ON FUNCTION pg_read_file(text) FROM ${APP}`, /may execute pg_read_file/],
      [`GRANT EXECUTE ON FUNCTION school.evidence_course(bigint) TO ${APP}`, `REVOKE EXECUTE ON FUNCTION school.evidence_course(bigint) FROM ${APP}`, /may execute school\.evidence_course\(bigint\)/],
      ["CREATE FUNCTION public.school_test_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'", "DROP FUNCTION public.school_test_probe()", /may execute public\.school_test_probe\(\)/],
      [`GRANT SET ON PARAMETER log_statement TO ${APP}`, `REVOKE SET ON PARAMETER log_statement FROM ${APP}`, /parameter log_statement/],
      [`ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT SELECT ON TABLES TO ${APP}`, `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE SELECT ON TABLES FROM ${APP}`, /default privileges/],
      [`CREATE DATABASE ${owned} OWNER ${APP}`, `DROP DATABASE ${owned}`, new RegExp(`owns database ${owned}`)],
      [`GRANT SELECT ON pg_catalog.pg_authid TO ${APP}`, `REVOKE SELECT ON pg_catalog.pg_authid FROM ${APP}`, /pg_authid/],
      ["GRANT SELECT ON pg_catalog.pg_statistic TO PUBLIC", "REVOKE SELECT ON pg_catalog.pg_statistic FROM PUBLIC", /pg_statistic/],
      [`CREATE SCHEMA school_test_other; GRANT USAGE ON SCHEMA school_test_other TO ${APP}`, "DROP SCHEMA school_test_other", /schema school_test_other/],
    ];
    for (const [grant, revoke, refusal] of cases) {
      await su.unsafe(grant);
      try {
        const e = await openDatabase({ driver: "postgres", url: app }).then(async (o) => { await o.close(); return null; }, (x: unknown) => x);
        expect({ grant, refused: e instanceof Refused }).toEqual({ grant, refused: true });
        expect((e as Error).message).toMatch(refusal);
      } finally {
        await su.unsafe(revoke);
      }
    }
    await (await openDatabase({ driver: "postgres", url: app })).close(); // every grant undone, it opens again
  }, 120_000);

  test("the server process exits 2 when school_app may execute lo_export, naming it", async () => {
    const { url, appUrl: app } = await fresh();
    const su = track(new Bun.SQL(url));
    const root = mkdtempSync(join(tmpdir(), "school-login-"));
    await su.unsafe(`GRANT EXECUTE ON FUNCTION lo_export(oid, text) TO ${APP}`);
    try {
      mkdirSync(join(root, "course", "lessons"), { recursive: true });
      const e = await startSchool({ ...process.env, HOST: "127.0.0.1", SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: app })
        .then((s) => { s.proc.kill(); return null; }, (x: unknown) => x);
      expect(e).toBeInstanceOf(NotStarted);
      expect((e as NotStarted).exitCode).toBe(2);
      expect((e as NotStarted).stderr).toContain("may execute lo_export");
      expect((e as NotStarted).stderr).not.toContain(TEST_APP_PASSWORD);
    } finally {
      await su.unsafe(`REVOKE EXECUTE ON FUNCTION lo_export(oid, text) FROM ${APP}`);
      rmSync(root, { recursive: true, force: true });
    }
  }, timeout(1));

  test("the functions school_app may run in schema school are exactly GRANTED_FUNCTIONS, as the migrations grant them", async () => {
    const { url } = await fresh();
    const su = track(new Bun.SQL(url));
    const rows = await su.unsafe(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p
      WHERE p.pronamespace = 'school'::regnamespace AND has_function_privilege('${APP}', p.oid, 'EXECUTE') ORDER BY p.oid::regprocedure::text COLLATE "C"`);
    expect([...rows].map((r: { f: string }) => r.f)).toEqual([...GRANTED_FUNCTIONS].sort());
  }, SLOW);

  test("RESTRICTED_FUNCTIONS and RESTRICTED_RELATIONS are what this Postgres withholds from an ordinary role", async () => {
    const url = await database();
    const su = track(new Bun.SQL(url));
    const role = `school_test_plain_${process.pid}`;
    await su.unsafe(`CREATE ROLE ${role} NOLOGIN`);
    try {
      const fns = await su.unsafe(`SELECT DISTINCT p.proname::text AS n FROM pg_proc p
        WHERE p.pronamespace IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) AND NOT has_function_privilege('${role}', p.oid, 'EXECUTE') ORDER BY 1`);
      expect([...fns].map((r: { n: string }) => r.n)).toEqual([...RESTRICTED_FUNCTIONS].sort());
      const rels = await su.unsafe(`SELECT c.relname::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'v', 'm', 'S', 'f', 'p')
          AND NOT has_table_privilege('${role}', c.oid, 'SELECT') ORDER BY 1`);
      expect([...rels].map((r: { n: string }) => r.n)).toEqual([...RESTRICTED_RELATIONS].sort());
      // And the one system relation an ordinary role may write: pg_settings, by UPDATE, which is SET.
      const writes = await su.unsafe(`SELECT c.oid::regclass::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('pg_catalog', 'information_schema') AND c.relkind IN ('r', 'v', 'm', 'S', 'f', 'p')
          AND has_table_privilege('${role}', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN')`);
      expect([...writes].map((r: { n: string }) => r.n)).toEqual(["pg_settings"]);
      expect([...await su.unsafe(`SELECT has_table_privilege('${role}', 'pg_settings', 'UPDATE') AND NOT has_table_privilege('${role}', 'pg_settings', 'INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') AS only`)][0].only).toBe(true);
    } finally {
      await su.unsafe(`DROP ROLE ${role}`);
    }
  }, SLOW);

  // F-2: a compromised server can ALTER ROLE school_app SET ...; the next migrate job clears it.
  test("the migrate job clears school_app's role settings, database-wide and per database", async () => {
    const { url, appUrl: app } = await fresh();
    const db = new URL(url).pathname.slice(1);
    const own = track(new Bun.SQL(app));
    await own.unsafe(`ALTER ROLE ${APP} SET search_path = public`);
    await own.unsafe(`ALTER ROLE ${APP} IN DATABASE ${db} SET statement_timeout = '1ms'`);
    const su = track(new Bun.SQL(url));
    const settings = async () => [...await su.unsafe(`SELECT count(*)::int AS n FROM pg_db_role_setting WHERE setrole = '${APP}'::regrole`)][0].n;
    expect(await settings()).toBe(2);
    await migrateRecord(url, TEST_APP_PASSWORD);
    expect(await settings()).toBe(0);
  }, SLOW);

  // F-4: the role is cluster-wide, so jobs on different databases contend for its catalog row.
  test("six migrate jobs on six databases of one cluster at once all succeed", async () => {
    const urls = await Promise.all(Array.from({ length: 6 }, () => database()));
    const done = await Promise.allSettled(urls.map((u) => migrateRecord(u, TEST_APP_PASSWORD)));
    expect(done.map((d) => d.status)).toEqual(urls.map(() => "fulfilled"));
  }, 120_000);

  test("a refusal names the login's problems and the host, never its password", async () => {
    const url = await database();
    const e = await openDatabase({ driver: "postgres", url }).catch((x: unknown) => x as Error);
    expect(e).toBeInstanceOf(Refused);
    const password = new URL(url).password;
    if (password !== "") expect((e as Error).message).not.toContain(password);
  }, SLOW);

  test("the server process refuses to start on a superuser URL, exit 2, naming the problem but no password", async () => {
    const { url } = await fresh();
    const root = mkdtempSync(join(tmpdir(), "school-login-"));
    try {
      mkdirSync(join(root, "course", "lessons"), { recursive: true });
      const e = await startSchool({ ...process.env, HOST: "127.0.0.1", SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: url })
        .then((s) => { s.proc.kill(); return null; }, (x: unknown) => x);
      expect(e).toBeInstanceOf(NotStarted);
      expect((e as NotStarted).exitCode).toBe(2);
      expect((e as NotStarted).stderr).toContain("is a superuser");
      const password = new URL(url).password;
      if (password !== "") expect((e as NotStarted).stderr).not.toContain(password);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, timeout(1));

  test("SEC-S1: the server process starts on school_app's URL with its password from SCHOOL_DATABASE_PASSWORD_FILE, and prints no password", async () => {
    const { appUrl: app } = await fresh();
    const root = mkdtempSync(join(tmpdir(), "school-login-"));
    try {
      mkdirSync(join(root, "course", "lessons"), { recursive: true });
      writeFileSync(join(root, "app_password"), `${TEST_APP_PASSWORD}\n`, { mode: 0o600 });
      const bare = new URL(app);
      bare.password = "";
      const s = await startSchool({ ...process.env, HOST: "127.0.0.1", SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: bare.toString(), SCHOOL_DATABASE_PASSWORD_FILE: join(root, "app_password") });
      s.proc.kill();
      const { stdout, stderr } = await s.output();
      expect(stdout).toContain(`as ${APP}`);
      expect(stdout + stderr).not.toContain(TEST_APP_PASSWORD);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, timeout(1));

  test("the server process starts on school_app's URL, says so, and applies no migration", async () => {
    const { appUrl: app } = await fresh();
    const root = mkdtempSync(join(tmpdir(), "school-login-"));
    try {
      mkdirSync(join(root, "course", "lessons"), { recursive: true });
      const s = await startSchool({ ...process.env, HOST: "127.0.0.1", SCHOOL_COURSES: `c=${join(root, "course")}`, SCHOOL_STATE: join(root, "state"), SCHOOL_DATABASE_URL: app });
      s.proc.kill();
      const { stdout, stderr } = await s.output();
      expect(stdout).toContain(`as ${APP}`);
      expect(stdout + stderr).not.toContain("applied migration");
      expect(stdout + stderr).not.toContain(TEST_APP_PASSWORD);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, timeout(1));
});
